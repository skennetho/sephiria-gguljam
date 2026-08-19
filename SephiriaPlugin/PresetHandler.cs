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

                var presetPanel = GameObject.FindObjectOfType<UI_PresetPanel>();
                if (presetPanel != null)
                {
                    var method = typeof(UI_PresetPanel).GetMethod("TryApplyCompactPresetData", 
                        BindingFlags.NonPublic | BindingFlags.Instance);
                    if (method != null)
                    {
                        object[] args = new object[] { slotIndex, decodedPlain, "" };
                        bool ok = (bool)method.Invoke(presetPanel, args);
                        errorMessage = (string)args[2];
                        if (ok)
                        {
                            SaveManager.Current.SetInt($"Preset_{slotIndex}_PresetEnabled", 1);
                            SaveManager.Current.SetInt($"Preset_{slotIndex}_SlotExists", 1);
                            if (!string.IsNullOrEmpty(presetName))
                            {
                                SaveManager.Current.SetString($"Preset_{slotIndex}_PresetName", presetName);
                            }
                            SaveManager.Save(true, false);

                            try
                            {
                                UIManager.Instance.GetElement<UI_SystemMessage>()?.Open($"프리셋 슬롯 {slotIndex + 1}에 '{presetName}' 저장 완료!", 3f);
                            }
                            catch { }

                            return true;
                        }
                    }
                }

                // Fallback: Directly write to SaveManager if UI_PresetPanel is not active
                return ApplyDirectlyToSaveManager(slotIndex, decodedPlain, presetName, out errorMessage);
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

                var dict = new Dictionary<string, string>();
                for (int i = 1; i < lines.Length; i++)
                {
                    string line = lines[i].Trim();
                    int idx = line.IndexOf(':');
                    if (idx > 0)
                    {
                        dict[line.Substring(0, idx)] = line.Substring(idx + 1);
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

                // F: Favorites
                if (dict.TryGetValue("F", out var fStr) && !string.IsNullOrEmpty(fStr))
                {
                    foreach (var idStr in fStr.Split(','))
                    {
                        if (int.TryParse(idStr, out var id))
                        {
                            SaveManager.Current.SetBool(targetPrefix + "Item_Favorite_" + id, true);
                        }
                    }
                }

                // P: Passives
                if (dict.TryGetValue("P", out var pStr) && !string.IsNullOrEmpty(pStr))
                {
                    foreach (var pairStr in pStr.Split(';'))
                    {
                        var parts = pairStr.Split(',');
                        if (parts.Length == 2 && ulong.TryParse(parts[0], out var pid) && int.TryParse(parts[1], out var pval))
                        {
                            SaveManager.Current.SetInt(targetPrefix + "PassivePoint_" + pid, pval);
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
                        if (parts.Length == 2 && int.TryParse(parts[1], out var rval))
                        {
                            string cat = Uri.UnescapeDataString(parts[0]);
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
                SaveManager.Save(true, false);

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
