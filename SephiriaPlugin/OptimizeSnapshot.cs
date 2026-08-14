using System;
using System.Collections.Generic;
using System.Text;
using UnityEngine;

namespace SephiriaTools
{
    /// <summary>
    /// 배치 최적화에 필요한 게임 상태를 <b>읽기만 해서</b> 순수 데이터로 뽑아낸다.
    /// 게임 상태를 바꾸는 코드는 여기에 없다.
    ///
    /// 탐색(어느 칸에 무엇을 놓을지)은 오버레이 쪽 JS 가 담당한다.
    /// 플러그인이 하는 일은 JS 가 절대 알 수 없는 것 두 가지뿐이다:
    ///
    ///  1. <b>석판 효과 해석</b> — 석판 효과는 47개 키워드짜리 텍스트 DSL 이고
    ///     회전마다 분기가 다르다. 게임의 <c>StoneTablet.ParseQuery</c> 를 그대로 호출해
    ///     "이 석판을 이 칸에 이 회전으로 놓으면 어느 칸에 무슨 효과" 까지 풀어서 넘긴다.
    ///     JS 로 재구현하면 어긋나고, 게임 패치 때마다 깨진다.
    ///  2. <b>런타임 상태</b> — 인챈트 수치, 칸별 임시 레벨, 각인, 회전 가능 여부.
    ///
    /// 좌표는 전부 선형 인덱스(idx = y * width + x)로 넘긴다.
    /// 격자는 직사각형이 아니다: 유효한 칸은 0 &lt;= idx &lt; CurrentInventoryStorage 뿐이고,
    /// 마지막 줄은 부분적으로만 존재할 수 있다. 포션 벨트(y = 100)는 격자가 아니라 제외한다.
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

        public static string Build(GridInventory inv, int seq)
        {
            if (inv == null) return null;

            int width = inv.Width;
            int storage = inv.CurrentInventoryStorage;
            int height = inv.Height;

            var sb = new StringBuilder(16384);
            sb.Append("{\"type\":\"optimize_data\",\"data\":{");
            sb.Append($"\"seq\":{seq}");
            sb.Append($",\"width\":{width},\"storage\":{storage},\"height\":{height}");

            AppendCellBase(sb, inv, width, storage);
            AppendFixedTruths(sb);

            // 격자 위 아이템 (포션 벨트 등 격자 밖 슬롯은 제외)
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

            AppendItems(sb, gridItems, inv, width, storage, height);
            AppendEngravings(sb, inv, width, storage, height);

            sb.Append("}}");
            return sb.ToString();
        }

        // ── 칸에 고정된 기본 레벨 ──────────────────────────────

        /// <summary>
        /// dungeonTempLevels 는 '칸'에 붙는 보너스라 아이템이 움직여도 따라가지 않는다.
        /// 인챈트는 반대로 '아이템'에 붙어 같이 움직인다(아이템 쪽에서 따로 내보낸다).
        /// </summary>
        private static void AppendCellBase(StringBuilder sb, GridInventory inv, int width, int storage)
        {
            var baseLevels = new int[storage];

            try
            {
                foreach (var kv in inv.dungeonTempLevels)
                {
                    int idx = kv.Key.y * width + kv.Key.x;
                    if (idx >= 0 && idx < storage) baseLevels[idx] += kv.Value;
                }
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"dungeonTempLevels 읽기 실패: {ex.Message}");
            }

            sb.Append(",\"cellBase\":[");
            for (int i = 0; i < storage; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(baseLevels[i]);
            }
            sb.Append(']');
        }

        /// <summary>
        /// 배치로 바꿀 수 없는 조건들. 최적화 대상이 아니라 '고정 입력'이다.
        /// FullHP 발동조건이 여기에 해당한다.
        /// </summary>
        private static void AppendFixedTruths(StringBuilder sb)
        {
            bool fullHp = false;
            try
            {
                var avatar = UnityEngine.Object.FindAnyObjectByType<PlayerAvatar>();
                var unit = avatar != null ? avatar.GetComponent<UnitAvatar>() : null;
                if (unit != null) fullHp = Mathf.Approximately(unit.hp, unit.MaxHp);
            }
            catch { /* 못 읽으면 false 로 둔다 */ }

            sb.Append($",\"fullHp\":{(fullHp ? "true" : "false")}");
        }

        // ── 아이템 ─────────────────────────────────────────────

        private static void AppendItems(StringBuilder sb,
            List<KeyValuePair<int, NewItemOwnInstance>> gridItems,
            GridInventory inv, int width, int storage, int height)
        {
            var patterns = new StringBuilder();
            int patternCount = 0;

            sb.Append(",\"items\":[");

            for (int i = 0; i < gridItems.Count; i++)
            {
                if (i > 0) sb.Append(',');

                int idx = gridItems[i].Key;
                var item = gridItems[i].Value;
                var charm = item.Charm;
                var tablet = item.StoneTablet;

                string kind = tablet != null ? "tablet" : (charm != null ? "charm" : "misc");

                sb.Append('{');
                sb.Append($"\"iid\":{item.InstanceID}");
                sb.Append($",\"eid\":{item.EntityID}");
                sb.Append($",\"idx\":{idx}");
                sb.Append($",\"kind\":\"{kind}\"");
                sb.Append($",\"name\":\"{Esc(SafeItemName(item))}\"");

                // BothSideCharm 은 이웃이 'Charm 타입' 인지를 본다 (석판 이웃은 조건을 만족시키지 않는다)
                bool isCharmType = false;
                try { isCharmType = item.Entity != null && item.Entity.type == EItemType.Charm; } catch { }
                sb.Append($",\"charmType\":{(isCharmType ? "true" : "false")}");

                if (charm != null)
                {
                    sb.Append($",\"maxLevel\":{charm.maxLevel}");
                    sb.Append($",\"enchant\":{ReadEnchant(item.InstanceID)}");
                    sb.Append($",\"level\":{SafeDisplayedLevel(charm)}");
                    string crit = charm.criteria != null ? charm.criteria.GetType().Name : null;
                    sb.Append($",\"criteria\":{(crit == null ? "null" : "\"" + Esc(crit) + "\"")}");
                    sb.Append($",\"magic\":{(charm is Charm_Magic ? "true" : "false")}");
                }

                if (tablet != null)
                {
                    bool rotatable = false;
                    try { rotatable = DungeonManager.IsTabletRotatable(item.InstanceID, tablet.isRotatable); }
                    catch { rotatable = tablet.isRotatable; }

                    sb.Append($",\"rot\":{tablet.rotation}");
                    sb.Append($",\"rotatable\":{(rotatable ? "true" : "false")}");
                    sb.Append($",\"pat\":{patternCount}");

                    if (patternCount > 0) patterns.Append(',');
                    AppendTabletPattern(patterns, tablet, item.InstanceID, rotatable,
                                        width, storage, height, movable: true, fixedIdx: -1);
                    patternCount++;
                }

                sb.Append('}');
            }

            sb.Append(']');
            sb.Append(",\"patterns\":[").Append(patterns).Append(']');
        }

        /// <summary>
        /// 각인(engraving)은 인벤토리 칸을 차지하지 않고 움직이지도 않지만,
        /// 발동조건은 후보 배치에 따라 달라진다. 따라서 위치는 고정, 조건은 매번 평가해야 한다.
        /// </summary>
        private static void AppendEngravings(StringBuilder sb, GridInventory inv,
            int width, int storage, int height)
        {
            sb.Append(",\"engravings\":[");

            try
            {
                int n = 0;
                foreach (var eng in inv.engravings)
                {
                    if (eng == null) continue;
                    int idx = eng.yIdx * width + eng.xIdx;
                    if (n > 0) sb.Append(',');
                    AppendTabletPattern(sb, eng, eng.instanceID, rotatable: false,
                                        width, storage, height, movable: false, fixedIdx: idx);
                    n++;
                }
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"각인 읽기 실패: {ex.Message}");
            }

            sb.Append(']');
        }

        // ── 석판 패턴 해석 ─────────────────────────────────────

        /// <summary>
        /// 석판을 가능한 모든 (회전, 놓을 칸) 조합으로 ParseQuery 에 넣어
        /// 절대 좌표 효과/조건 목록을 미리 풀어둔다.
        ///
        /// 회전 불가 석판은 현재 회전만, 움직이지 않는 각인은 현재 칸만 계산한다.
        /// </summary>
        private static void AppendTabletPattern(StringBuilder sb, StoneTablet tablet, int instanceID,
            bool rotatable, int width, int storage, int height, bool movable, int fixedIdx)
        {
            string effectQuery, conditionQuery;
            try
            {
                effectQuery = tablet.GetQuery(instanceID);
                conditionQuery = tablet.GetConditionQuery(instanceID);
            }
            catch
            {
                effectQuery = tablet.query;
                conditionQuery = tablet.conditionQuery;
            }

            sb.Append('{');
            sb.Append($"\"iid\":{instanceID}");
            sb.Append($",\"movable\":{(movable ? "true" : "false")}");
            sb.Append(",\"rots\":{");

            int rotFrom = 0, rotTo = 3;
            if (!rotatable) { rotFrom = rotTo = Mathf.Clamp(tablet.rotation, 0, 3); }

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
                            default: continue;   // None 은 아무것도 하지 않는다
                        }

                        // 격자 밖으로 나간 효과는 버린다. 게임은 행렬에 그냥 쓰지만
                        // 그 좌표에는 어떤 참도 없으므로 결과에 영향이 없다.
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
                        // 격자 밖은 -1 로 보낸다. '아이템 있음' 조건이면 영원히 만족하지 못한다는 뜻.
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
