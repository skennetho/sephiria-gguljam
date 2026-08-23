using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using UnityEngine;

namespace SephiriaTools
{
    public static class PresetHandler
    {
        public static bool ApplyPreset(int slotIndex, string presetCode, string presetName, out string errorMessage)
        {
            errorMessage = "";
            try
            {
                if (string.IsNullOrEmpty(presetCode))
                {
                    errorMessage = "프리셋 코드가 비어있습니다.";
                    return false;
                }

                string decodedPlain = TryDecodePreset(presetCode);
                if (string.IsNullOrEmpty(decodedPlain) || !decodedPlain.StartsWith("AAP1"))
                {
                    errorMessage = "유효하지 않은 프리셋 코드 포맷입니다.";
                    return false;
                }

                // 1. SaveManager 에 프리셋 데이터 직접 완벽 저장
                bool ok = ApplyDirectlyToSaveManager(slotIndex, decodedPlain, presetName, out errorMessage);
                if (!ok) return false;

                // 2. 인게임 프리셋 패널이 열려있거나 씬에 존재하면 실시간 UI 새로고침 및 슬롯 선택
                try
                {
                    var presetPanel = GameObject.FindObjectOfType<UI_PresetPanel>();
                    if (presetPanel != null)
                    {
                        var rebuildMethod = typeof(UI_PresetPanel).GetMethod("RebuildPresetSlotButtons", 
                            BindingFlags.NonPublic | BindingFlags.Instance);
                        rebuildMethod?.Invoke(presetPanel, null);

                        var selectMethod = typeof(UI_PresetPanel).GetMethod("SelectPresetSlot", 
                            BindingFlags.NonPublic | BindingFlags.Instance);
                        selectMethod?.Invoke(presetPanel, new object[] { slotIndex });
                    }
                }
                catch (Exception exUI)
                {
                    Plugin.Log.LogWarning($"Preset UI refresh skipped: {exUI.Message}");
                }

                // 3. 인게임 시스템 토스트 메시지 팝업
                try
                {
                    UIManager.Instance.GetElement<UI_SystemMessage>()?.Open($"프리셋 슬롯 {slotIndex + 1}에 '{presetName}' 저장 완료!", 3f);
                }
                catch { }

                return true;
            }
            catch (Exception ex)
            {
                errorMessage = ex.Message;
                Plugin.Log.LogError($"ApplyPreset Error: {ex.Message}");
                return false;
            }
        }

        private static bool ApplyDirectlyToSaveManager(int slotIndex, string plainData, string presetName, out string errorMessage)
        {
            errorMessage = "";
            try
            {
                string targetPrefix = $"Preset_{slotIndex}_";
                string[] lines = plainData.Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries);
                if (lines.Length == 0 || lines[0].Trim() != "AAP1")
                {
                    errorMessage = "유효하지 않은 AAP1 헤더입니다.";
                    return false;
                }

                var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                for (int i = 1; i < lines.Length; i++)
                {
                    string line = lines[i].Trim();
                    int idx = line.IndexOf(':');
                    if (idx > 0)
                    {
                        dict[line.Substring(0, idx).Trim()] = line.Substring(idx + 1).Trim();
                    }
                }

                // W: Weapon
                if (dict.TryGetValue("W", out var wStr) && int.TryParse(wStr, out var weaponId))
                {
                    SaveManager.Current.SetInt(targetPrefix + "StartingWeaponID", weaponId);
                }

                // C: Costume
                if (dict.TryGetValue("C", out var cStr))
                {
                    string costume = Uri.UnescapeDataString(cStr);
                    SaveManager.Current.SetString(targetPrefix + "PlayerCostume", costume);
                }

                // S: Skin
                if (dict.TryGetValue("S", out var sStr))
                {
                    string skin = Uri.UnescapeDataString(sStr);
                    string costume = SaveManager.Current.GetString(targetPrefix + "PlayerCostume", "PinkRabbit");
                    SaveManager.Current.SetString(targetPrefix + "PlayerCostume_CurrentSkin_" + costume, skin);
                }

                // F: Favorites - 기존 부적 초기화 후 새 부적 반영
                try
                {
                    int[] allItemIds = ItemDatabase.GetAllItemID();
                    if (allItemIds != null)
                    {
                        foreach (var id in allItemIds)
                        {
                            SaveManager.Current.SetBool(targetPrefix + "Item_Favorite_" + id, false);
                        }
                    }
                }
                catch { }

                if (dict.TryGetValue("F", out var fStr) && !string.IsNullOrEmpty(fStr))
                {
                    foreach (var idStr in fStr.Split(','))
                    {
                        if (int.TryParse(idStr.Trim(), out var id))
                        {
                            SaveManager.Current.SetBool(targetPrefix + "Item_Favorite_" + id, true);
                        }
                    }
                }

                // P: Passives - 기존 패시브 초기화 후 새 패시브 반영
                try
                {
                    var allPassives = PassiveDatabase.GetAll();
                    if (allPassives != null)
                    {
                        foreach (var p in allPassives)
                        {
                            SaveManager.Current.SetInt(targetPrefix + "PassivePoint_" + p.id, 0);
                        }
                    }
                }
                catch { }

                if (dict.TryGetValue("P", out var pStr) && !string.IsNullOrEmpty(pStr))
                {
                    foreach (var pairStr in pStr.Split(';'))
                    {
                        var parts = pairStr.Split(',');
                        if (parts.Length == 2 && ulong.TryParse(parts[0].Trim(), out var pid) && int.TryParse(parts[1].Trim(), out var pval))
                        {
                            SaveManager.Current.SetInt(targetPrefix + "PassivePoint_" + pid, pval);
                        }
                    }
                }

                // D: Dimension Pocket
                if (dict.TryGetValue("D", out var dStr) && !string.IsNullOrEmpty(dStr))
                {
                    var dItems = dStr.Split(';');
                    SaveManager.Current.SetInt(targetPrefix + "DimensionPocketCount", dItems.Length);
                    for (int j = 0; j < dItems.Length; j++)
                    {
                        var parts = dItems[j].Split(',');
                        if (parts.Length == 3 && int.TryParse(parts[0].Trim(), out var inst) && int.TryParse(parts[1].Trim(), out var ent) && int.TryParse(parts[2].Trim(), out var qty))
                        {
                            SaveManager.Current.SetInt(targetPrefix + $"DimensionPocket{j}_InstanceID", inst);
                            SaveManager.Current.SetInt(targetPrefix + $"DimensionPocket{j}_EntityID", ent);
                            SaveManager.Current.SetInt(targetPrefix + $"DimensionPocket{j}_Quantity", qty);
                        }
                    }
                }

                // B: Drop bonus
                if (dict.TryGetValue("B", out var bStr) && int.TryParse(bStr, out var bval))
                {
                    SaveManager.Current.SetInt(targetPrefix + "FruitSkewer_AdaptiveItemDropBonus", bval);
                }

                // R: Fruit Skewer
                if (dict.TryGetValue("R", out var rStr) && !string.IsNullOrEmpty(rStr))
                {
                    var rItems = rStr.Split(';');
                    SaveManager.Current.SetInt(targetPrefix + "FruitSkewer_FruitCount", rItems.Length);
                    for (int k = 0; k < rItems.Length; k++)
                    {
                        var parts = rItems[k].Split(',');
                        if (parts.Length == 2 && int.TryParse(parts[1].Trim(), out var rval))
                        {
                            string cat = Uri.UnescapeDataString(parts[0].Trim());
                            SaveManager.Current.SetString(targetPrefix + $"FruitSkewer_Fruit{k}_Category", cat);
                            SaveManager.Current.SetInt(targetPrefix + $"FruitSkewer_Fruit{k}_Value", rval);
                        }
                    }
                }

                SaveManager.Current.SetInt(targetPrefix + "SlotExists", 1);
                SaveManager.Current.SetInt(targetPrefix + "PresetEnabled", 1);
                if (!string.IsNullOrEmpty(presetName))
                {
                    SaveManager.Current.SetString(targetPrefix + "PresetName", presetName);
                }

                // PresetSlotOrder 갱신
                string order = SaveManager.Current.GetString("PresetSlotOrder", "");
                var orderList = new List<string>(order.Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries));
                if (!orderList.Contains(slotIndex.ToString()))
                {
                    orderList.Add(slotIndex.ToString());
                    SaveManager.Current.SetString("PresetSlotOrder", string.Join(",", orderList));
                }

                SaveManager.Save(true, false);
                return true;
            }
            catch (Exception ex)
            {
                errorMessage = ex.Message;
                return false;
            }
        }

        private static string TryDecodePreset(string rawData)
        {
            if (string.IsNullOrWhiteSpace(rawData)) return "";
            string text = rawData.Trim();
            if (text.StartsWith("AAF_PRESET_OBFZ|v1", StringComparison.Ordinal))
            {
                return DeobfuscatePresetData(text.Substring("AAF_PRESET_OBFZ|v1".Length).Trim());
            }
            if (text.StartsWith("AAP1")) return text;
            return "";
        }

        private static string DeobfuscatePresetData(string payload)
        {
            try
            {
                byte[] array = Convert.FromBase64String(payload);
                byte[] key = Encoding.UTF8.GetBytes("ActionAnimalFarmPresetShareKey");
                for (int i = 0; i < array.Length; i++)
                {
                    array[i] ^= key[i % key.Length];
                }
                using (var ms = new MemoryStream(array))
                using (var gz = new GZipStream(ms, CompressionMode.Decompress))
                using (var outMs = new MemoryStream())
                {
                    gz.CopyTo(outMs);
                    return Encoding.UTF8.GetString(outMs.ToArray());
                }
            }
            catch
            {
                return "";
            }
        }
    }
}
