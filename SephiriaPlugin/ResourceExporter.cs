using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text;
using UnityEngine;

namespace SephiriaTools
{
    /// <summary>
    /// ItemDatabase 에서 참(Charm)/석판(StoneTablet) 전체와 콤보 카테고리를 추출해
    /// assets/ 로 덤프한다.
    ///
    /// 아이템 데이터는 게임 진행에 따라 점진적으로 로드되므로(타이틀 화면에서는 일부만 존재),
    /// "한 번 성공하면 끝"이 아니라 <b>수집 개수가 늘어날 때마다 다시 쓴다</b>.
    /// 예전 구현은 첫 성공에 _hasExported 를 세워버려 타이틀 화면 시점의 일부만 남았다.
    ///
    /// 아이템의 resourcePrefab 에서 Charm_Basic / StoneTablet 컴포넌트를 읽으면
    /// 런타임 인스턴스 없이도 maxLevel·발동조건·석판 쿼리를 정적으로 얻을 수 있다.
    /// </summary>
    internal static class ResourceExporter
    {
        // 마지막으로 덤프한 상태의 지문. 아이템 수가 늘거나 현지화가 뒤늦게 로드되어
        // 이름이 바뀌면 다시 쓴다. (타이틀 화면에서는 아이템도 일부만 로드되고
        // 이름도 아직 내부 키로 나온다)
        private static string _lastSignature = null;

        // 지금까지 본 모든 아이템의 합집합. 씬 전환 때 일부가 언로드되면
        // ItemDatabase 조회 결과가 줄어들 수 있는데, 그때 더 작은 덤프로
        // 덮어쓰지 않도록 누적해 둔다. (실측: 353개 -> 330개로 감소하는 경우 있음)
        private static readonly Dictionary<int, ItemEntity> _seen = new Dictionary<int, ItemEntity>();

        public static void ExportAllResources(string assetsDir)
        {
            try
            {
                var items = CollectItemEntities();
                if (items.Count == 0) return;

                // ID 범위가 아니라 EItemType 으로 거른다.
                // 예전엔 1000~2999 로 잘랐는데, 그러면 그 범위 밖의 참/석판을 놓치고
                // 빌드 글에 자주 등장하는 포션/스크롤도 전부 빠진다.
                // 동료(5000대)·퍼즐(6000대) 같은 Misc 는 여전히 제외된다.
                foreach (var item in items)
                {
                    if (item == null) continue;
                    if (IsExportable(item.type)) _seen[item.id] = item;
                }

                var relevant = new List<ItemEntity>(_seen.Count);
                foreach (var kv in _seen)
                {
                    // 언로드된 ScriptableObject 는 Unity 의 == 오버로드로 걸러진다
                    if (kv.Value != null) relevant.Add(kv.Value);
                }
                if (relevant.Count == 0) return;

                relevant.Sort((a, b) => a.id.CompareTo(b.id));

                // 개수와 대표 이름 몇 개로 지문을 만들어, 변화가 없으면 건너뛴다
                string signature = BuildSignature(relevant);
                if (signature == _lastSignature) return;

                string iconsDir = Path.Combine(assetsDir, "icons");
                string combosDir = Path.Combine(assetsDir, "combos");
                if (!Directory.Exists(iconsDir)) Directory.CreateDirectory(iconsDir);
                if (!Directory.Exists(combosDir)) Directory.CreateDirectory(combosDir);

                var sb = new StringBuilder();
                sb.Append("{\n  \"schema\": 2,\n  \"items\": [\n");

                for (int i = 0; i < relevant.Count; i++)
                {
                    AppendItem(sb, relevant[i], iconsDir);
                    sb.Append(i < relevant.Count - 1 ? ",\n" : "\n");
                }

                sb.Append("  ],\n  \"combos\": [\n");

                var categories = CollectCategories();
                for (int i = 0; i < categories.Count; i++)
                {
                    AppendCategory(sb, categories[i], combosDir);
                    sb.Append(i < categories.Count - 1 ? ",\n" : "\n");
                }

                sb.Append("  ]\n}\n");

                string json = sb.ToString();
                // BOM 없는 UTF-8. Encoding.UTF8 은 BOM 을 붙이는데, 그러면
                // JSON.parse / fetch().json() 가 깨진다.
                var utf8NoBom = new UTF8Encoding(false);
                File.WriteAllText(Path.Combine(assetsDir, "database.json"), json, utf8NoBom);
                File.WriteAllText(Path.Combine(assetsDir, "database.js"),
                    "window.OFFLINE_DATABASE = " + json + ";", utf8NoBom);

                _lastSignature = signature;
                Plugin.Log.LogInfo(
                    $"ResourceExporter: 아이템 {relevant.Count}개 (참/석판), 콤보 {categories.Count}개 덤프 -> {assetsDir}");
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"ResourceExporter 오류: {ex.Message}");
            }
        }

        /// <summary>개수 + 앞뒤 몇 개의 이름으로 만든 가벼운 지문.</summary>
        private static string BuildSignature(List<ItemEntity> items)
        {
            var sb = new StringBuilder();
            sb.Append(items.Count);
            for (int i = 0; i < items.Count; i += Math.Max(1, items.Count / 8))
            {
                sb.Append('|').Append(SafeName(items[i]));
            }
            return sb.ToString();
        }

        /// <summary>대시보드/오버레이가 쓰는 종류만. 동료·퍼즐 등 Misc 는 제외.</summary>
        private static bool IsExportable(EItemType t)
        {
            return t == EItemType.Charm
                || t == EItemType.StoneTablet
                || t == EItemType.Potion
                || t == EItemType.Scroll
                || t == EItemType.ThrowingWeapon
                || t == EItemType.Food;
        }

        // ── 수집 ───────────────────────────────────────────────────

        private static List<ItemEntity> CollectItemEntities()
        {
            var result = new List<ItemEntity>();

            try
            {
                var field = typeof(ItemDatabase).GetField("itemDictionary",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
                if (field != null && field.GetValue(null) is IDictionary dict)
                {
                    foreach (DictionaryEntry entry in dict)
                    {
                        if (entry.Value is ItemEntity entity) result.Add(entity);
                    }
                }
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"ItemDatabase 리플렉션 실패: {ex.Message}");
            }

            // 데이터베이스가 아직 비어 있으면 로드된 에셋에서 긁는다
            if (result.Count == 0)
            {
                var loaded = Resources.FindObjectsOfTypeAll<ItemEntity>();
                if (loaded != null) result.AddRange(loaded);
            }

            return result;
        }

        private static List<ItemCategoryEntity> CollectCategories()
        {
            var result = new List<ItemCategoryEntity>();

            var found = Resources.FindObjectsOfTypeAll<ItemCategoryEntity>();
            if (found == null || found.Length == 0) found = Resources.LoadAll<ItemCategoryEntity>("");
            if (found != null)
            {
                foreach (var cat in found)
                {
                    if (cat != null) result.Add(cat);
                }
            }

            return result;
        }

        // ── 직렬화 ─────────────────────────────────────────────────

        private static void AppendItem(StringBuilder sb, ItemEntity item, string iconsDir)
        {
            string iconFile = item.id + ".png";
            if (item.icon != null && item.icon.texture != null)
            {
                SaveSpriteToPNG(item.icon, Path.Combine(iconsDir, iconFile));
            }

            sb.Append("    {");
            sb.Append($"\"id\": {item.id}");
            sb.Append($", \"name\": \"{Esc(SafeName(item))}\"");
            sb.Append($", \"type\": \"{Esc(item.type.ToString())}\"");
            sb.Append($", \"rarity\": \"{Esc(item.rarity.ToString())}\"");
            sb.Append($", \"icon\": \"{Esc(iconFile)}\"");
            sb.Append($", \"cost\": {item.cost}");

            // 콤보 소속 (ItemEntity.categories = 카테고리 id 목록)
            sb.Append(", \"categories\": [");
            if (item.categories != null)
            {
                for (int i = 0; i < item.categories.Count; i++)
                {
                    if (i > 0) sb.Append(", ");
                    sb.Append($"\"{Esc(item.categories[i])}\"");
                }
            }
            sb.Append("]");

            AppendPrefabDetails(sb, item);

            sb.Append("}");
        }

        /// <summary>
        /// resourcePrefab 에 붙은 Charm_Basic / StoneTablet 컴포넌트에서
        /// 최대 강화수·발동조건·석판 쿼리를 읽는다. 런타임 인스턴스가 없어도 된다.
        /// </summary>
        private static void AppendPrefabDetails(StringBuilder sb, ItemEntity item)
        {
            if (item.resourcePrefab == null) return;

            try
            {
                var charm = item.resourcePrefab.GetComponent<Charm_Basic>();
                if (charm != null)
                {
                    sb.Append($", \"maxLevel\": {charm.maxLevel}");
                    // criteria 는 프리팹에만 지정되며 코드상 대입 지점이 없다.
                    // 클래스명으로 내보내고 최적화 엔진이 그 이름으로 분기한다.
                    string criteria = charm.criteria != null ? charm.criteria.GetType().Name : null;
                    sb.Append($", \"criteria\": {(criteria == null ? "null" : "\"" + Esc(criteria) + "\"")}");
                    sb.Append($", \"isMagicBook\": {(charm is Charm_Magic ? "true" : "false")}");
                }

                var tablet = item.resourcePrefab.GetComponent<StoneTablet>();
                if (tablet != null)
                {
                    // 석판 효과는 고정된 도형이 아니라 텍스트 DSL 이다.
                    // (LEFT/RIGHT/TOP/IDX/CHECKERBOARD ... 40여 키워드)
                    sb.Append($", \"query\": \"{Esc(tablet.query)}\"");
                    sb.Append($", \"conditionQuery\": \"{Esc(tablet.conditionQuery)}\"");
                    sb.Append($", \"isRotatable\": {(tablet.isRotatable ? "true" : "false")}");
                }
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"프리팹 상세 추출 실패 (id={item.id}): {ex.Message}");
            }
        }

        private static void AppendCategory(StringBuilder sb, ItemCategoryEntity cat, string combosDir)
        {
            string iconFile = cat.id + ".png";
            if (cat.categoryIcon != null && cat.categoryIcon.texture != null)
            {
                SaveSpriteToPNG(cat.categoryIcon, Path.Combine(combosDir, iconFile));
            }

            sb.Append("    {");
            sb.Append($"\"id\": \"{Esc(cat.id)}\"");
            sb.Append($", \"name\": \"{Esc(SafeCategoryName(cat))}\"");
            sb.Append($", \"icon\": \"{Esc(iconFile)}\"");
            sb.Append($", \"isEnabled\": {(cat.isEnabled ? "true" : "false")}");

            // setStatus = '세트 효과' 임계값 (콤보 효과와는 별개 메커니즘)
            sb.Append(", \"setTiers\": [");
            if (cat.setStatus != null)
            {
                for (int i = 0; i < cat.setStatus.Length; i++)
                {
                    var t = cat.setStatus[i];
                    if (t == null) continue;
                    if (i > 0) sb.Append(", ");
                    sb.Append($"{{\"count\": {t.itemCount}, \"status\": \"{Esc(t.status)}\"}}");
                }
            }
            sb.Append("]");

            // 진짜 콤보 단계는 comboEffectPrefab 의 ComboEffectBase.addStatByCombo 에 있다.
            // 위키의 2/4/6/8/10 과 대조할 대상은 setStatus 가 아니라 이쪽이다.
            sb.Append(", \"comboTiers\": [");
            try
            {
                if (cat.comboEffectPrefab != null)
                {
                    var combo = cat.comboEffectPrefab.GetComponent<ComboEffectBase>();
                    if (combo != null && combo.addStatByCombo != null)
                    {
                        for (int i = 0; i < combo.addStatByCombo.Length; i++)
                        {
                            var cs = combo.addStatByCombo[i];
                            if (cs == null) continue;
                            if (i > 0) sb.Append(", ");
                            sb.Append($"{{\"count\": {cs.comboCount}, \"status\": [");
                            if (cs.status != null)
                            {
                                for (int k = 0; k < cs.status.Length; k++)
                                {
                                    if (k > 0) sb.Append(", ");
                                    sb.Append($"\"{Esc(cs.status[k])}\"");
                                }
                            }
                            sb.Append("]}");
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"콤보 단계 추출 실패 ({cat.id}): {ex.Message}");
            }
            sb.Append("]}");
        }

        private static string SafeName(ItemEntity item)
        {
            // ItemEntity.Name 은 aName 을 그냥 쓰지 않는다:
            //  - 마법서(Charm_Magic)면 담긴 마법의 이름을 돌려주고
            //  - KeywordDatabase.Convert 로 키워드 치환까지 한다.
            // aName 을 직접 읽으면 '라이트닝 볼트' 같은 마법서가 전부 껍데기 이름으로 나온다.
            try
            {
                string display = item.Name;
                if (!string.IsNullOrEmpty(display)) return CleanName(display);
            }
            catch { }

            try
            {
                string localized = item.aName != null ? item.aName.ToString() : null;
                if (!string.IsNullOrEmpty(localized)) return CleanName(localized);
            }
            catch { }

            return CleanName(item.name);
        }

        private static string SafeCategoryName(ItemCategoryEntity cat)
        {
            try
            {
                string localized = cat.categoryName != null ? cat.categoryName.ToString() : null;
                if (!string.IsNullOrEmpty(localized)) return localized;
            }
            catch { }
            return cat.id;
        }

        private static string CleanName(string s)
        {
            if (string.IsNullOrEmpty(s)) return "Item";
            return System.Text.RegularExpressions.Regex.Replace(s, @"^\d+_\s*", "").Trim();
        }

        private static string Esc(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            var sb = new StringBuilder(s.Length + 8);
            foreach (char c in s)
            {
                switch (c)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '"': sb.Append("\\\""); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }

        // ── 아이콘 ─────────────────────────────────────────────────

        private static void SaveSpriteToPNG(Sprite sprite, string destinationPath)
        {
            if (File.Exists(destinationPath)) return;

            try
            {
                Texture2D tex = sprite.texture;
                if (tex == null) return;

                RenderTexture rt = RenderTexture.GetTemporary(
                    tex.width, tex.height, 0,
                    RenderTextureFormat.Default, RenderTextureReadWrite.Linear);

                Graphics.Blit(tex, rt);
                RenderTexture previous = RenderTexture.active;
                RenderTexture.active = rt;

                int w = (int)sprite.rect.width;
                int h = (int)sprite.rect.height;
                Texture2D result = new Texture2D(w, h, TextureFormat.RGBA32, false);
                result.ReadPixels(new Rect(sprite.rect.x, sprite.rect.y, w, h), 0, 0);
                result.Apply();

                RenderTexture.active = previous;
                RenderTexture.ReleaseTemporary(rt);

                byte[] bytes = UnityEngine.ImageConversion.EncodeToPNG(result);
                File.WriteAllBytes(destinationPath, bytes);
            }
            catch { }
        }
    }
}
