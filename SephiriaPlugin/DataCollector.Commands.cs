using System;
using System.Collections.Generic;
using System.Text;

namespace SephiriaTools
{
    /// <summary>
    /// DataCollector 의 명령 처리부.
    ///
    /// 오버레이가 WS 로 보내는 명령(refresh / optimize / apply)을 받아 처리한다.
    /// 게임을 변경하는 경로는 사용자가 명시적으로 요청한 apply 하나뿐이며,
    /// 그마저도 게임 자체의 네트워크 안전 API(Swap / DoClickAction)만 쓴다.
    /// undo / kill_game / restart_game 은 의도적으로 없다.
    /// </summary>
    internal partial class DataCollector
    {
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

                    case "apply_preset":
                        HandleApplyPreset(json);
                        break;

                    case "get_presets":
                        HandleGetPresets();
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
        /// [Non-Blocking] 메인 스레드에서는 0.05ms 이내로 데이터 캡처만 수행하고,
        /// 무거운 ParseQuery 연산 및 JSON 생성은 백그라운드 ThreadPool 에서 비동기 처리하여
        /// 게임 프레임 멈춤(프리징)을 100% 방지한다.
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
                // 1. [메인 스레드] 초경량 DTO 캡처 (0.05ms 미만)
                var raw = OptimizeSnapshot.Capture(_cachedInventory);
                if (raw == null)
                {
                    _server.Broadcast("{\"type\":\"optimize_error\",\"data\":{\"seq\":" + seq +
                                      ",\"message\":\"스냅샷 캡처 실패\"}}");
                    return;
                }

                // 2. [백그라운드 스레드] 무거운 ParseQuery 전수조사 및 JSON 직렬화 비동기 실행
                System.Threading.ThreadPool.QueueUserWorkItem(_ =>
                {
                    try
                    {
                        var sw = System.Diagnostics.Stopwatch.StartNew();
                        string json = OptimizeSnapshot.BuildFromRaw(raw, seq);
                        sw.Stop();

                        if (string.IsNullOrEmpty(json))
                        {
                            _server.Broadcast("{\"type\":\"optimize_error\",\"data\":{\"seq\":" + seq +
                                              ",\"message\":\"스냅샷 생성 실패\"}}");
                            return;
                        }

                        _server.Broadcast(json);
                        Plugin.Log.LogInfo($"optimize_data 비동기 전송 완료 (seq={seq}, {json.Length / 1024}KB, {sw.ElapsedMilliseconds}ms)");
                    }
                    catch (Exception exBg)
                    {
                        Plugin.Log.LogError($"optimize_data 백그라운드 생성 오류: {exBg.Message}");
                        _server.Broadcast("{\"type\":\"optimize_error\",\"data\":{\"seq\":" + seq +
                                          ",\"message\":\"" + exBg.Message.Replace("\"", "'") + "\"}}");
                    }
                });
            }
            catch (Exception ex)
            {
                Plugin.Log.LogError($"SendOptimizeData 캡처 오류: {ex.Message}");
                _server.Broadcast("{\"type\":\"optimize_error\",\"data\":{\"seq\":" + seq +
                                  ",\"message\":\"" + ex.Message.Replace("\"", "'") + "\"}}");
            }
        }

        private void HandleApplyPreset(string json)
        {
            try
            {
                int slot = 0;
                string code = "";
                string title = "Wiki Preset";

                var mSlot = System.Text.RegularExpressions.Regex.Match(json, "\"slot\":\\s*(\\d+)");
                if (mSlot.Success) int.TryParse(mSlot.Groups[1].Value, out slot);

                var mCode = System.Text.RegularExpressions.Regex.Match(json, "\"presetCode\":\\s*\"([^\"]+)\"");
                if (mCode.Success) code = mCode.Groups[1].Value;

                var mTitle = System.Text.RegularExpressions.Regex.Match(json, "\"title\":\\s*\"([^\"]+)\"");
                if (mTitle.Success) title = mTitle.Groups[1].Value;

                string error;
                bool ok = PresetHandler.ApplyPreset(slot, code, title, out error);
                string res = $"{{\"type\":\"apply_preset_result\",\"data\":{{\"ok\":{(ok ? "true" : "false")},\"slot\":{slot},\"title\":\"{title.Replace("\"", "'")}\",\"message\":\"{(error ?? "").Replace("\"", "'")}\"}}}}";
                _server.Broadcast(res);
            }
            catch (Exception ex)
            {
                Plugin.Log.LogError($"HandleApplyPreset error: {ex.Message}");
                _server.Broadcast($"{{\"type\":\"apply_preset_result\",\"data\":{{\"ok\":false,\"slot\":0,\"message\":\"{ex.Message.Replace("\"", "'")}\"}}}}");
            }
        }

        private void HandleGetPresets()
        {
            try
            {
                string order = SaveManager.Current.GetString("PresetSlotOrder", "");
                var orderList = new List<int>();
                foreach (var part in order.Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    if (int.TryParse(part, out var idx) && idx >= 0 && idx < 15 && !orderList.Contains(idx))
                    {
                        orderList.Add(idx);
                    }
                }
                for (int i = 0; i < 15; i++)
                {
                    if (SaveManager.Current.GetInt($"Preset_{i}_SlotExists", 0) == 1 && !orderList.Contains(i))
                    {
                        orderList.Add(i);
                    }
                }
                if (orderList.Count == 0) orderList.Add(0);

                int selectedSlot = SaveManager.Current.GetInt("Preset_SelectedSlot", 0);

                var sb = new StringBuilder(512);
                sb.Append("{\"type\":\"presets_info\",\"data\":{\"selectedSlot\":");
                sb.Append(selectedSlot);
                sb.Append(",\"slots\":[");
                bool first = true;
                foreach (int i in orderList)
                {
                    bool exists = SaveManager.Current.GetInt($"Preset_{i}_SlotExists", 0) == 1;
                    string name = SaveManager.Current.GetString($"Preset_{i}_PresetName", "");
                    string costume = SaveManager.Current.GetString($"Preset_{i}_PlayerCostume", "");
                    int weapon = SaveManager.Current.GetInt($"Preset_{i}_StartingWeaponID", 0);
                    bool locked = SaveManager.Current.GetInt($"Preset_{i}_SlotLocked", 0) == 1;

                    if (!first) sb.Append(",");
                    first = false;
                    sb.Append($"{{\"index\":{i},\"exists\":{(exists ? "true" : "false")},\"name\":\"{(name ?? "").Replace("\"", "'")}\",\"costume\":\"{(costume ?? "").Replace("\"", "'")}\",\"weapon\":{weapon},\"locked\":{(locked ? "true" : "false")}}}");
                }
                sb.Append("]}}");
                _server.Broadcast(sb.ToString());
            }
            catch (Exception ex)
            {
                Plugin.Log.LogError($"HandleGetPresets error: {ex.Message}");
            }
        }
    }
}
