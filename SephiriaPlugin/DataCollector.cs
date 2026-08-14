using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEngine;

namespace SephiriaTools
{
    /// <summary>
    /// Collects real-time inventory and map data from the game and sends it
    /// to connected dashboard clients via WebSocket.
    /// 읽기 전용. 게임 상태를 바꾸는 명령(apply/undo/kill_game/restart_game)은 제거했다.
    /// 처리하는 명령: refresh, optimize(= 스냅샷 요청).
    /// </summary>
    internal class DataCollector
    {
        private readonly SimpleWebSocketServer _server;
        private float _lastUpdateTime;
        private float _lastMapUpdateTime;
        private const float UPDATE_INTERVAL = 0.5f;
        private const float MAP_UPDATE_INTERVAL = 0.3f;


        private GridInventory _cachedInventory;
        private PlayerAvatar _cachedPlayer;
        private FloorGenerator _cachedFloorGenerator;

        // Reflection caches for non-public fields
        private FieldInfo _floorDataField;
        private FieldInfo _roomInstancesField;

        public DataCollector(SimpleWebSocketServer server)
        {
            _server = server;
            _server.OnCommandReceived += HandleCommand;

            _floorDataField = typeof(FloorGenerator).GetField("data", BindingFlags.Instance | BindingFlags.NonPublic);
            _roomInstancesField = typeof(EnhancedProceduralFloorGenerator).GetField("roomInstances", BindingFlags.Instance | BindingFlags.NonPublic);
        }

        public void Update()
        {
            // 클라이언트가 보낸 명령을 메인 스레드에서 처리한다.
            // (읽기 스레드는 큐에 넣기만 하므로 이 호출이 없으면 명령이 영원히 처리되지 않는다)
            _server.ProcessMessages();

            if (!_server.HasClients) return;

            // Inventory update
            if (Time.time - _lastUpdateTime >= UPDATE_INTERVAL)
            {
                _lastUpdateTime = Time.time;
                try
                {
                    EnsurePlayerReference();
                    if (_cachedInventory != null)
                    {
                        var snapshot = CollectSnapshot();
                        if (snapshot != null)
                        {
                            string json = JsonHelper.ToJson(snapshot);
                            _server.Broadcast(json);

                            // Trigger offline database dump once inventory is active
                            TriggerResourceExport();
                        }
                    }
                }
                catch (Exception ex)
                {
                    Plugin.Log.LogError($"DataCollector Inventory Update error: {ex.Message}");
                }
            }

            // Real-time Map & Player position update
            if (Time.time - _lastMapUpdateTime >= MAP_UPDATE_INTERVAL)
            {
                _lastMapUpdateTime = Time.time;
                try
                {
                    EnsurePlayerReference();
                    if (_cachedPlayer != null)
                    {
                        var mapSnapshot = CollectMapSnapshot();
                        if (mapSnapshot != null)
                        {
                            string json = JsonHelper.ToJson(mapSnapshot);
                            _server.Broadcast(json);
                        }
                    }
                }
                catch (Exception ex)
                {
                    Plugin.Log.LogError($"DataCollector Map Update error: {ex.Message}");
                }
            }
        }

        private void TriggerResourceExport()
        {
            // Single source of truth for the export destination lives in Plugin.TryExport().
            Plugin.Instance?.TryExport();
        }

        private void EnsurePlayerReference()
        {
            if (_cachedPlayer == null)
            {
                _cachedPlayer = UnityEngine.Object.FindAnyObjectByType<PlayerAvatar>();
            }

            if (_cachedPlayer != null && _cachedInventory == null)
            {
                var unitAvatar = _cachedPlayer.GetComponent<UnitAvatar>();
                if (unitAvatar != null)
                    _cachedInventory = unitAvatar.GetComponent<GridInventory>();
                else
                    _cachedInventory = _cachedPlayer.GetComponent<GridInventory>();

                if (_cachedInventory != null)
                {
                    Plugin.Log.LogInfo("Found player inventory: " +
                        $"Width={_cachedInventory.Width}, Height={_cachedInventory.Height}");
                }
            }

            if (_cachedFloorGenerator == null)
            {
                _cachedFloorGenerator = UnityEngine.Object.FindAnyObjectByType<FloorGenerator>();
            }
        }

        // ── Map Snapshot collection ────────────────────────────────

        private MapSnapshot CollectMapSnapshot()
        {
            if (_cachedPlayer == null) return null;

            var map = new MapData();

            Vector3 pos = _cachedPlayer.transform.position;
            map.playerPos.x = pos.x;
            map.playerPos.y = pos.y;

            if (_cachedFloorGenerator != null)
            {
                var floorData = _floorDataField?.GetValue(_cachedFloorGenerator) as FloorData;
                if (floorData != null)
                {
                    map.stageName = floorData.stageName ?? "Dungeon";
                    map.floorName = floorData.name ?? "Floor";
                    map.floorSeed = floorData.seed;
                }
                else
                {
                    map.stageName = "Dungeon";
                    map.floorName = "Current Floor";
                }

                CollectRoomsFromFloorGenerator(map);
            }
            else
            {
                map.stageName = "Dungeon";
                map.floorName = "Current Floor";
            }

            return new MapSnapshot { data = map };
        }

        private void CollectRoomsFromFloorGenerator(MapData map)
        {
            try
            {
                var procGen = _cachedFloorGenerator as EnhancedProceduralFloorGenerator;
                if (procGen == null)
                {
                    procGen = UnityEngine.Object.FindAnyObjectByType<EnhancedProceduralFloorGenerator>();
                }

                if (procGen != null && _roomInstancesField != null)
                {
                    var roomInstances = _roomInstancesField.GetValue(procGen) as System.Collections.IDictionary;
                    if (roomInstances != null)
                    {
                        Vector3 playerPos = _cachedPlayer.transform.position;

                        foreach (System.Collections.DictionaryEntry entry in roomInstances)
                        {
                            var roomInst = entry.Value as TileBasedRoomInstance;
                            if (roomInst == null) continue;

                            string purpose = "Combat";
                            if (roomInst.Metadata != null)
                            {
                                string tag = roomInst.Metadata.tag;
                                string name = roomInst.Metadata.name;
                                if (!string.IsNullOrEmpty(tag)) purpose = tag;
                                else if (!string.IsNullOrEmpty(name)) purpose = name;
                            }

                            bool isInside = playerPos.x >= roomInst.bottomLeft.x && playerPos.x <= roomInst.topRight.x &&
                                            playerPos.y >= roomInst.bottomLeft.y && playerPos.y <= roomInst.topRight.y;

                            if (isInside)
                            {
                                map.playerPos.currentRoomId = roomInst.id;
                            }

                            var rInfo = new RoomInfo
                            {
                                id = roomInst.id,
                                gridX = roomInst.pos.x,
                                gridY = roomInst.pos.y,
                                sizeX = roomInst.size.x,
                                sizeY = roomInst.size.y,
                                worldBottomLeftX = roomInst.bottomLeft.x,
                                worldBottomLeftY = roomInst.bottomLeft.y,
                                worldTopRightX = roomInst.topRight.x,
                                worldTopRightY = roomInst.topRight.y,
                                purpose = purpose,
                                roomType = GetRoomTypeName(roomInst.size),
                                isRevealed = roomInst.isRevealedOnServer,
                                isCurrentRoom = isInside
                            };

                            map.rooms.Add(rInfo);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"CollectRooms error: {ex.Message}");
            }
        }

        private string GetRoomTypeName(Vector2Int size)
        {
            if (size.x == 1 && size.y == 1) return "ONE";
            if (size.x == 2 && size.y == 1) return "TWO_H";
            if (size.x == 1 && size.y == 2) return "TWO_V";
            if (size.x >= 2 && size.y >= 2) return "FOUR";
            return "ONE";
        }

        // ── Inventory Snapshot collection ──────────────────────────

        private InventorySnapshot CollectSnapshot()
        {
            if (_cachedInventory == null) return null;

            var data = new InventoryData
            {
                width = _cachedInventory.Width,
                height = _cachedInventory.Height,
                storage = _cachedInventory.CurrentInventoryStorage,
                currentScore = GetCurrentScore()
            };

            CollectItems(data);
            CollectSetEffects(data);

            return new InventorySnapshot { data = data };
        }

        private void CollectItems(InventoryData data)
        {
            try
            {
                var matrix = _cachedInventory.inventoryMatrix;
                if (matrix == null) return;

                foreach (var kvp in matrix)
                {
                    var pos = kvp.Key;
                    var item = kvp.Value;
                    if (item == null) continue;

                    var charm = item.Charm;
                    var entity = item.Entity;

                    var info = new CharmItemInfo
                    {
                        instanceID = item.InstanceID,
                        entityID = item.EntityID,
                        name = GetItemName(item),
                        x = pos.x,
                        y = pos.y,
                        level = GetItemLevel(pos),
                        maxLevel = charm != null ? charm.maxLevel : 0,
                        category = entity != null ? entity.type.ToString() : "Unknown",
                        color = GetItemColor(item),
                        rarity = entity != null ? entity.rarity.ToString() : "Common",
                        isActive = charm != null && charm.IsEffectEnabled,
                        activateCriteria = GetActivateCriteriaName(charm),
                        criteriaDescription = GetCriteriaDescription(charm),
                        criteriaMetAtCurrentPosition = IsCriteriaMet(charm)
                    };

                    data.items.Add(info);
                }
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"CollectItems error: {ex.Message}");
            }
        }

        private void CollectSetEffects(InventoryData data)
        {
            try
            {
                var setEffectCount = _cachedInventory.currentSetEffectCount;
                if (setEffectCount == null) return;

                foreach (var kvp in setEffectCount)
                {
                    data.setEffects.Add(new SetEffectInfo
                    {
                        name = kvp.Key,
                        count = kvp.Value,
                        maxCount = 0
                    });
                }
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"CollectSetEffects error: {ex.Message}");
            }
        }

        private string GetItemName(NewItemOwnInstance item)
        {
            try
            {
                return item.Name ?? $"Item #{item.EntityID}";
            }
            catch
            {
                return $"Item #{item.EntityID}";
            }
        }

        private int GetItemLevel(ItemPosition pos)
        {
            try
            {
                if (_cachedInventory.levelMatrix != null &&
                    _cachedInventory.levelMatrix.TryGetValue(pos, out int level))
                    return level;
            }
            catch { }
            return 0;
        }

        private string GetItemColor(NewItemOwnInstance item)
        {
            try
            {
                var entity = item.Entity;
                if (entity != null)
                {
                    var charm = item.Charm;
                    if (charm != null)
                    {
                        if (charm.darkCloud) return "Blue";
                        if (charm.flameGround) return "Red";
                    }
                }
            }
            catch { }
            return "None";
        }

        private string GetActivateCriteriaName(Charm_Basic charm)
        {
            if (charm == null) return "None";

            try
            {
                var criteria = charm.criteria;
                if (criteria == null) return "Always";

                return criteria.GetType().Name.Replace("CharmActivateCriteria_", "");
            }
            catch { }
            return "Unknown";
        }

        private string GetCriteriaDescription(Charm_Basic charm)
        {
            var criteria = GetActivateCriteriaName(charm);
            switch (criteria)
            {
                case "TopInInventory": return "인벤토리 최상단에 배치";
                case "BottomInInventory": return "인벤토리 최하단에 배치";
                case "Inside": return "가장자리가 아닌 내부에 배치";
                case "Outlined": return "가장자리에 배치";
                case "BothSideCharm": return "양쪽에 참이 있어야 활성화";
                case "BothSidesAreEmpty": return "양쪽이 비어있어야 활성화";
                case "NeighborsAreFull": return "상하좌우가 모두 채워져야 활성화";
                case "SideEnd": return "행의 끝에 배치";
                case "Near8MagicBook": return "주변 8칸에 마법서가 있어야 활성화";
                case "FullHP": return "HP가 풀일 때 활성화";
                case "Always": return "조건 없음 (항상 활성)";
                case "None": return "참이 아닌 아이템";
                default: return "알 수 없는 조건";
            }
        }

        private bool IsCriteriaMet(Charm_Basic charm)
        {
            if (charm == null) return false;
            try
            {
                return charm.IsEffectEnabled;
            }
            catch { }
            return false;
        }

        private float GetCurrentScore()
        {
            try
            {
                return _cachedInventory.EvaluateCurrentAutoArrangeScore();
            }
            catch
            {
                return 0f;
            }
        }

        // ── Command handling ───────────────────────────────────────

        private void HandleCommand(string json)
        {
            try
            {
                var cmd = JsonHelper.ParseCommand(json);
                Plugin.Log.LogInfo($"Received command: {cmd.type}");

                switch (cmd.type)
                {
                    case "refresh":
                        _lastUpdateTime = 0;
                        _lastMapUpdateTime = 0;
                        break;

                    case "optimize":
                        // 탐색은 오버레이가 한다. 플러그인은 계산에 필요한 상태만 넘긴다.
                        SendOptimizeData(cmd.seq);
                        break;

                    case "apply":
                        HandleApply(json, cmd.seq);
                        break;

                    default:
                        // undo / kill_game / restart_game 은 의도적으로 없다.
                        // 게임을 변경하는 경로는 사용자가 명시적으로 요청한 apply 하나뿐이며,
                        // 그마저도 게임 자체의 네트워크 안전 API(Swap/DoClickAction)만 쓴다.
                        Plugin.Log.LogWarning($"Unknown command type: {cmd.type}");
                        break;
                }
            }
            catch (Exception ex)
            {
                Plugin.Log.LogError($"HandleCommand error: {ex.Message}");
            }
        }

        /// <summary>
        /// 오버레이가 계산한 배치를 실제 인벤토리에 반영한다.
        ///
        /// 행렬을 직접 고치지 않고 게임의 공개 API 만 쓴다:
        ///  - 이동: GridInventory.Swap — 게임 UI 의 드래그와 같은 경로.
        ///    호스트에서는 즉시 실행, 클라이언트에서는 Mirror Cmd 로 서버에 전달된다.
        ///  - 회전: GridInventory.DoClickAction — 석판 클릭 회전과 같은 경로.
        ///    참(charm)에는 아무 동작도 하지 않으므로 안전하다.
        ///
        /// 클라이언트에서는 명령이 비동기라 로컬 행렬이 늦게 갱신된다.
        /// 그래서 매 스왑마다 행렬을 다시 읽지 않고, 시작 시점 스냅샷 위에서
        /// 시뮬레이션하며 스왑 순서를 만든다. 서버는 명령을 순서대로 처리하므로
        /// 이 순서가 그대로 재현된다.
        /// </summary>
        private void HandleApply(string json, int seq)
        {
            if (_cachedInventory == null)
            {
                BroadcastApplyResult(seq, false, 0, 0, "인벤토리를 찾지 못했습니다");
                return;
            }

            try
            {
                var moves = JsonHelper.ParseApplyMoves(json);
                if (moves.Count == 0)
                {
                    BroadcastApplyResult(seq, false, 0, 0, "이동 목록이 비어 있습니다");
                    return;
                }

                int width = _cachedInventory.Width;
                int height = _cachedInventory.Height;
                int storage = _cachedInventory.CurrentInventoryStorage;

                // 시작 시점 배치 스냅샷 (선형 idx -> instanceID, instanceID -> idx)
                var posOf = new Dictionary<int, int>();
                var itemAt = new Dictionary<int, int>();
                foreach (var kv in _cachedInventory.inventoryMatrix)
                {
                    if (kv.Value == null) continue;
                    if (kv.Key.x < 0 || kv.Key.x >= width) continue;
                    if (kv.Key.y < 0 || kv.Key.y >= height) continue;
                    int idx = kv.Key.y * width + kv.Key.x;
                    if (idx < 0 || idx >= storage) continue;
                    posOf[kv.Value.InstanceID] = idx;
                    itemAt[idx] = kv.Value.InstanceID;
                }

                int swaps = 0;
                foreach (var mv in moves)
                {
                    if (!posOf.TryGetValue(mv.iid, out int cur))
                    {
                        Plugin.Log.LogWarning($"apply: 아이템 {mv.iid} 이 격자에 없음 - 건너뜀");
                        continue;
                    }
                    if (mv.idx < 0 || mv.idx >= storage) continue;
                    if (cur == mv.idx) continue;

                    _cachedInventory.Swap(
                        (sbyte)(cur % width), (sbyte)(cur / width),
                        (sbyte)(mv.idx % width), (sbyte)(mv.idx / width));
                    swaps++;

                    // 시뮬레이션 갱신: 목표 칸의 점유자와 자리를 맞바꾼다
                    bool occupied = itemAt.TryGetValue(mv.idx, out int other);
                    itemAt[mv.idx] = mv.iid;
                    posOf[mv.iid] = mv.idx;
                    if (occupied && other != mv.iid)
                    {
                        itemAt[cur] = other;
                        posOf[other] = cur;
                    }
                    else
                    {
                        itemAt.Remove(cur);
                    }
                }

                // 회전: 이동이 모두 큐에 들어간 뒤 목표 칸 기준으로 돌린다.
                // DoClickAction 은 1스텝(+90°)씩만 돌므로 필요한 횟수만큼 호출한다.
                int rotations = 0;
                foreach (var mv in moves)
                {
                    var item = _cachedInventory.FindItemByInstanceID(mv.iid);
                    var tablet = item != null ? item.StoneTablet : null;
                    if (tablet == null) continue;

                    bool rotatable;
                    try { rotatable = DungeonManager.IsTabletRotatable(mv.iid, tablet.isRotatable); }
                    catch { rotatable = tablet.isRotatable; }
                    if (!rotatable) continue;

                    int steps = ((mv.rot - tablet.rotation) % 4 + 4) % 4;
                    if (steps == 0) continue;
                    if (!posOf.TryGetValue(mv.iid, out int at)) continue;

                    var pos = new ItemPosition(at % width, at / width);
                    for (int k = 0; k < steps; k++) _cachedInventory.DoClickAction(pos);
                    rotations += steps;
                }

                Plugin.Log.LogInfo($"apply 완료: 스왑 {swaps}회, 회전 {rotations}스텝 (seq={seq})");
                BroadcastApplyResult(seq, true, swaps, rotations, null);

                // 다음 Update 에서 곧바로 최신 인벤토리를 방송하게 한다
                _lastUpdateTime = 0;
            }
            catch (Exception ex)
            {
                Plugin.Log.LogError($"apply 오류: {ex.Message}");
                BroadcastApplyResult(seq, false, 0, 0, ex.Message);
            }
        }

        private void BroadcastApplyResult(int seq, bool ok, int swaps, int rotations, string error)
        {
            var sb = new StringBuilder(160);
            sb.Append("{\"type\":\"apply_result\",\"data\":{");
            sb.Append($"\"seq\":{seq},\"ok\":{(ok ? "true" : "false")}");
            sb.Append($",\"swaps\":{swaps},\"rotations\":{rotations}");
            if (!string.IsNullOrEmpty(error))
                sb.Append($",\"message\":\"{error.Replace("\"", "'")}\"");
            sb.Append("}}");
            _server.Broadcast(sb.ToString());
        }

        /// <summary>
        /// 최적화에 필요한 게임 상태를 스냅샷으로 만들어 보낸다.
        /// 게임을 건드리지 않고 읽기만 한다. 실제 탐색은 오버레이에서 수행한다.
        /// </summary>
        private void SendOptimizeData(int seq)
        {
            if (_cachedInventory == null)
            {
                Plugin.Log.LogWarning("optimize 요청을 받았으나 인벤토리를 아직 찾지 못했습니다.");
                _server.Broadcast("{\"type\":\"optimize_error\",\"data\":{\"seq\":" + seq +
                                  ",\"message\":\"인벤토리를 찾지 못했습니다\"}}");
                return;
            }

            try
            {
                var sw = System.Diagnostics.Stopwatch.StartNew();
                string json = OptimizeSnapshot.Build(_cachedInventory, seq);
                sw.Stop();

                if (string.IsNullOrEmpty(json))
                {
                    _server.Broadcast("{\"type\":\"optimize_error\",\"data\":{\"seq\":" + seq +
                                      ",\"message\":\"스냅샷 생성 실패\"}}");
                    return;
                }

                _server.Broadcast(json);
                Plugin.Log.LogInfo($"optimize_data 전송 (seq={seq}, {json.Length / 1024}KB, {sw.ElapsedMilliseconds}ms)");
            }
            catch (Exception ex)
            {
                Plugin.Log.LogError($"optimize_data 생성 오류: {ex.Message}");
                _server.Broadcast("{\"type\":\"optimize_error\",\"data\":{\"seq\":" + seq +
                                  ",\"message\":\"" + ex.Message.Replace("\"", "'") + "\"}}");
            }
        }
    }
}
