using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
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

                    default:
                        // apply / undo / kill_game / restart_game 은 의도적으로 제거했다.
                        // 이 플러그인은 게임 상태를 바꾸지 않는다 (읽기 전용).
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
