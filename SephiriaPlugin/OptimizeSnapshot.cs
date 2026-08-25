using System;
using System.Collections.Generic;
using System.Text;
using UnityEngine;

namespace SephiriaTools
{
    internal class RawItemData
    {
        public int iid;
        public int eid;
        public int idx;
        public string kind;
        public string name;
        public bool charmType;
        public int maxLevel;
        public int enchant;
        public int level;
        public string criteria;
        public bool magic;
        public int rot;
        public bool rotatable;
        public string effectQuery;
        public string conditionQuery;
    }

    internal class RawEngravingData
    {
        public int idx;
        public int instanceID;
        public string effectQuery;
        public string conditionQuery;
    }

    internal class RawSnapshotData
    {
        public int width;
        public int height;
        public int storage;
        public int[] baseLevels;
        public bool fullHp;
        public List<RawItemData> items = new List<RawItemData>();
        public List<RawEngravingData> engravings = new List<RawEngravingData>();
    }

    /// <summary>
    /// 배치 최적화에 필요한 게임 상태를 <b>읽기만 해서</b> 순수 데이터로 뽑아낸다.
    /// 게임 상태를 바꾸는 코드는 여기에 없다.
    ///
    /// 메인 스레드에서는 Capture()로 가벼운 DTO만 즉시 복사(0.05ms 미만)하고,
    /// 무거운 ParseQuery 전수조사 및 JSON 직렬화는 BuildFromRaw()를 통해
    /// 백그라운드 스레드에서 비동기로 수행하여 게임 프리징(0 FPS Drop)을 완전히 방지한다.
    /// </summary>
    internal static class OptimizeSnapshot
    {
        // 효과 종류 코드 (JSON 을 작게 유지하려고 숫자로)
        private const int OP_INCREASE = 1;   // 레벨 +param
        private const int OP_DISABLE = 2;   // 해당 칸 비활성화
        private const int OP_IGNORE = 3;   // 해당 칸의 발동조건 무시
        private const int OP_MULTIPLY = 4;   // 레벨 배수 (여러 개면 '합'해서 곱한다)

        // 석판 자체 발동조건 종류 코드
        private const int CRIT_ANY_ITEM = 1;
        private const int CRIT_ONLY_CHARM = 2;
        private const int CRIT_PLACED = 3;

        /// <summary>
        /// [Unity Main Thread] 0.05ms 미만으로 인벤토리 상태를 DTO로 복사한다.
        /// </summary>
        public static RawSnapshotData Capture(GridInventory inv)
        {
            if (inv == null) return null;

            int width = inv.Width;
            int storage = inv.CurrentInventoryStorage;
            int height = inv.Height;

            var raw = new RawSnapshotData
            {
                width = width,
                height = height,
                storage = storage,
                baseLevels = new int[storage],
                fullHp = false
            };

            // 1. 칸별 임시 레벨
            try
            {
                foreach (var kv in inv.dungeonTempLevels)
                {
                    int idx = kv.Key.y * width + kv.Key.x;
                    if (idx >= 0 && idx < storage) raw.baseLevels[idx] += kv.Value;
                }
            }
            catch { }

            // 2. FullHP 여부
            try
            {
                var avatar = UnityEngine.Object.FindAnyObjectByType<PlayerAvatar>();
                var unit = avatar != null ? avatar.GetComponent<UnitAvatar>() : null;
                if (unit != null) raw.fullHp = Mathf.Approximately(unit.hp, unit.MaxHp);
            }
            catch { }

            // 3. 격자 위 아이템 목록
            var gridItems = new List<KeyValuePair<int, NewItemOwnInstance>>();
            foreach (var kv in inv.inventoryMatrix)
            {
                if (kv.Value == null) continue;
                int idx = kv.Key.y * width + kv.Key.x;
                if (kv.Key.x < 0 || kv.Key.x >= width) continue;
                if (kv.Key.y < 0 || kv.Key.y >= height) continue;
                if (idx < 0 || idx >= storage) continue;
                gridItems.Add(new KeyValuePair<int, NewItemOwnInstance>(idx, kv.Value));
            }
            gridItems.Sort((a, b) => a.Key.CompareTo(b.Key));

            foreach (var kv in gridItems)
            {
                int idx = kv.Key;
                var item = kv.Value;
                var charm = item.Charm;
                var tablet = item.StoneTablet;
                string kind = tablet != null ? "tablet" : (charm != null ? "charm" : "misc");

                bool isCharmType = false;
                try { isCharmType = item.Entity != null && item.Entity.type == EItemType.Charm; } catch { }

                var rawItem = new RawItemData
                {
                    iid = item.InstanceID,
                    eid = item.EntityID,
                    idx = idx,
                    kind = kind,
                    name = SafeItemName(item),
                    charmType = isCharmType
                };

                if (charm != null)
                {
                    rawItem.maxLevel = charm.maxLevel;
                    rawItem.enchant = ReadEnchant(item.InstanceID);
                    rawItem.level = SafeDisplayedLevel(charm);
                    rawItem.criteria = charm.criteria != null ? charm.criteria.GetType().Name : null;
                    rawItem.magic = charm is Charm_Magic;
                }

                if (tablet != null)
                {
                    bool rotatable = false;
                    try { rotatable = DungeonManager.IsTabletRotatable(item.InstanceID, tablet.isRotatable); }
                    catch { rotatable = tablet.isRotatable; }

                    rawItem.rot = tablet.rotation;
                    rawItem.rotatable = rotatable;

                    try
                    {
                        rawItem.effectQuery = tablet.GetQuery(item.InstanceID);
                        rawItem.conditionQuery = tablet.GetConditionQuery(item.InstanceID);
                    }
                    catch
                    {
                        rawItem.effectQuery = tablet.query;
                        rawItem.conditionQuery = tablet.conditionQuery;
                    }
                }

                raw.items.Add(rawItem);
            }

            // 4. 각인 목록
            try
            {
                foreach (var eng in inv.engravings)
                {
                    if (eng == null) continue;
                    int idx = eng.yIdx * width + eng.xIdx;
                    string eq, cq;
                    try
                    {
                        eq = eng.GetQuery(eng.instanceID);
                        cq = eng.GetConditionQuery(eng.instanceID);
                    }
                    catch
                    {
                        eq = eng.query;
                        cq = eng.conditionQuery;
                    }

                    raw.engravings.Add(new RawEngravingData
                    {
                        idx = idx,
                        instanceID = eng.instanceID,
                        effectQuery = eq,
                        conditionQuery = cq
                    });
                }
            }
            catch { }

            return raw;
        }

        /// <summary>
        /// [Background Worker Thread Safe]
        /// 무거운 ParseQuery 전수조사 및 JSON 빌드를 백그라운드 스레드에서 안전하게 수행한다.
        /// </summary>
        public static string BuildFromRaw(RawSnapshotData raw, int seq)
        {
            if (raw == null) return null;

            int width = raw.width;
            int storage = raw.storage;
            int height = raw.height;

            var sb = new StringBuilder(16384);
            sb.Append("{\"type\":\"optimize_data\",\"data\":{");
            sb.Append($"\"seq\":{seq}");
            sb.Append($",\"width\":{width},\"storage\":{storage},\"height\":{height}");

            // cellBase
            sb.Append(",\"cellBase\":[");
            for (int i = 0; i < storage; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(raw.baseLevels[i]);
            }
            sb.Append(']');

            // fullHp
            sb.Append($",\"fullHp\":{(raw.fullHp ? "true" : "false")}");

            // items & tablet patterns
            var patterns = new StringBuilder();
            int patternCount = 0;

            sb.Append(",\"items\":[");
            for (int i = 0; i < raw.items.Count; i++)
            {
                if (i > 0) sb.Append(',');
                var item = raw.items[i];

                sb.Append('{');
                sb.Append($"\"iid\":{item.iid}");
                sb.Append($",\"eid\":{item.eid}");
                sb.Append($",\"idx\":{item.idx}");
                sb.Append($",\"kind\":\"{item.kind}\"");
                sb.Append($",\"name\":\"{Esc(item.name)}\"");
                sb.Append($",\"charmType\":{(item.charmType ? "true" : "false")}");

                if (item.kind == "charm")
                {
                    sb.Append($",\"maxLevel\":{item.maxLevel}");
                    sb.Append($",\"enchant\":{item.enchant}");
                    sb.Append($",\"level\":{item.level}");
                    sb.Append($",\"criteria\":{(item.criteria == null ? "null" : "\"" + Esc(item.criteria) + "\"")}");
                    sb.Append($",\"magic\":{(item.magic ? "true" : "false")}");
                }

                if (item.kind == "tablet")
                {
                    sb.Append($",\"rot\":{item.rot}");
                    sb.Append($",\"rotatable\":{(item.rotatable ? "true" : "false")}");
                    sb.Append($",\"pat\":{patternCount}");

                    if (patternCount > 0) patterns.Append(',');
                    AppendRawTabletPattern(patterns, item.iid, item.rot, item.rotatable,
                        item.effectQuery, item.conditionQuery, width, storage, height, movable: true, fixedIdx: -1);
                    patternCount++;
                }

                sb.Append('}');
            }
            sb.Append(']');
            sb.Append(",\"patterns\":[").Append(patterns).Append(']');

            // engravings
            sb.Append(",\"engravings\":[");
            for (int i = 0; i < raw.engravings.Count; i++)
            {
                if (i > 0) sb.Append(',');
                var eng = raw.engravings[i];
                AppendRawTabletPattern(sb, eng.instanceID, 0, false,
                    eng.effectQuery, eng.conditionQuery, width, storage, height, movable: false, fixedIdx: eng.idx);
            }
            sb.Append(']');

            sb.Append("}}");
            return sb.ToString();
        }

        public static string Build(GridInventory inv, int seq)
        {
            var raw = Capture(inv);
            return BuildFromRaw(raw, seq);
        }

        // ── 석판 패턴 해석 (Background Thread) ──────────────────

        private static void AppendRawTabletPattern(StringBuilder sb, int instanceID, int rotation,
            bool rotatable, string effectQuery, string conditionQuery,
            int width, int storage, int height, bool movable, int fixedIdx)
        {
            sb.Append('{');
            sb.Append($"\"iid\":{instanceID}");
            sb.Append($",\"movable\":{(movable ? "true" : "false")}");
            sb.Append(",\"rots\":{");

            int rotFrom = 0, rotTo = 3;
            if (!rotatable) { rotFrom = rotTo = Mathf.Clamp(rotation, 0, 3); }

            bool firstRot = true;
            for (int rot = rotFrom; rot <= rotTo; rot++)
            {
                if (!firstRot) sb.Append(',');
                firstRot = false;
                sb.Append($"\"{rot}\":{{");

                bool firstOrigin = true;
                for (int origin = 0; origin < storage; origin++)
                {
                    if (!movable && origin != fixedIdx) continue;

                    var pos = new ItemPosition(origin % width, origin / width);

                    if (!firstOrigin) sb.Append(',');
                    firstOrigin = false;

                    sb.Append($"\"{origin}\":{{");
                    AppendEffects(sb, effectQuery, width, height, storage, pos, rot);
                    sb.Append(',');
                    AppendCriteria(sb, conditionQuery, width, height, storage, pos, rot);
                    sb.Append('}');
                }

                sb.Append('}');
            }

            sb.Append("}}");
        }

        private static void AppendEffects(StringBuilder sb, string query,
            int width, int height, int storage, ItemPosition origin, int rot)
        {
            sb.Append("\"e\":[");

            if (!string.IsNullOrEmpty(query))
            {
                try
                {
                    var parsed = StoneTablet.ParseQuery(query, width, height, storage, origin, rot, out _);
                    bool first = true;
                    foreach (var meta in parsed)
                    {
                        var eff = new StoneTablet.AdditionEffectData(meta);

                        int op;
                        switch (eff.effectType)
                        {
                            case StoneTablet.EffectType.IncreaseConstLevel: op = OP_INCREASE; break;
                            case StoneTablet.EffectType.Disable: op = OP_DISABLE; break;
                            case StoneTablet.EffectType.IgnoreCriteria: op = OP_IGNORE; break;
                            case StoneTablet.EffectType.MultiplyConstLevel: op = OP_MULTIPLY; break;
                            default: continue;
                        }

                        int idx = eff.position.y * width + eff.position.x;
                        if (eff.position.x < 0 || eff.position.x >= width) continue;
                        if (idx < 0 || idx >= storage) continue;

                        if (!first) sb.Append(',');
                        first = false;
                        sb.Append($"[{idx},{op},{eff.levelParam}]");
                    }
                }
                catch (Exception ex)
                {
                    Plugin.Log.LogWarning($"석판 효과 파싱 실패 (rot={rot}): {ex.Message}");
                }
            }

            sb.Append(']');
        }

        private static void AppendCriteria(StringBuilder sb, string query,
            int width, int height, int storage, ItemPosition origin, int rot)
        {
            sb.Append("\"c\":[");

            if (!string.IsNullOrEmpty(query))
            {
                try
                {
                    var parsed = StoneTablet.ParseQuery(query, width, height, storage, origin, rot, out _);
                    bool first = true;
                    foreach (var meta in parsed)
                    {
                        var crit = new StoneTablet.AdditionCriteriaData(meta);

                        int op;
                        switch (crit.effectType)
                        {
                            case StoneTablet.CriteriaType.AnyItem: op = CRIT_ANY_ITEM; break;
                            case StoneTablet.CriteriaType.OnlyCharm: op = CRIT_ONLY_CHARM; break;
                            case StoneTablet.CriteriaType.Placed: op = CRIT_PLACED; break;
                            default: continue;
                        }

                        int idx = crit.position.y * width + crit.position.x;
                        bool offGrid = crit.position.x < 0 || crit.position.x >= width
                                       || idx < 0 || idx >= storage;

                        if (!first) sb.Append(',');
                        first = false;
                        sb.Append($"[{(offGrid ? -1 : idx)},{op}]");
                    }
                }
                catch (Exception ex)
                {
                    Plugin.Log.LogWarning($"석판 조건 파싱 실패 (rot={rot}): {ex.Message}");
                }
            }

            sb.Append(']');
        }

        // ── 보조 ───────────────────────────────────────────────

        private static int ReadEnchant(int instanceID)
        {
            try
            {
                var dm = DungeonManager.Instance;
                if (dm == null) return 0;
                string raw = dm.GetGlobalItemStatValue(instanceID, "Enchant");
                return int.TryParse(raw, out int v) ? v : 0;
            }
            catch { return 0; }
        }

        private static int SafeDisplayedLevel(Charm_Basic charm)
        {
            try { return charm.DisplayedLevel; } catch { return 0; }
        }

        private static string SafeItemName(NewItemOwnInstance item)
        {
            try
            {
                var entity = item.Entity;
                if (entity != null)
                {
                    string n = entity.Name;
                    if (!string.IsNullOrEmpty(n)) return n;
                }
            }
            catch { }
            return "아이템 " + item.EntityID;
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
    }
}
