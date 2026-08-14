using System;
using System.Collections.Generic;
using System.Text;

namespace SephiriaTools
{
    // ── WebSocket Messages ─────────────────────────────────────────

    [Serializable]
    public class InventorySnapshot
    {
        public string type = "inventory_update";
        public InventoryData data;
    }

    [Serializable]
    public class MapSnapshot
    {
        public string type = "map_update";
        public MapData data;
    }

    // ── Inventory Data Models ──────────────────────────────────────

    [Serializable]
    public class InventoryData
    {
        public int width;
        public int height;
        // Height 는 ceil(storage / width) 라 마지막 줄이 부분적으로만 존재할 수 있다.
        // BottomInInventory/Inside/Outlined/BothSidesAreEmpty 발동조건이 이 값을 직접 쓰므로
        // height 만으로는 재현할 수 없다.
        public int storage;
        public List<CharmItemInfo> items = new List<CharmItemInfo>();
        public List<ArrangementBonusInfo> arrangementBonuses = new List<ArrangementBonusInfo>();
        public List<SetEffectInfo> setEffects = new List<SetEffectInfo>();
        public float currentScore;
    }

    [Serializable]
    public class CharmItemInfo
    {
        public int instanceID;
        public int entityID;
        public string name;
        public int x;
        public int y;
        public int level;
        public int maxLevel;
        public string category;
        public string color;
        public string rarity;
        public bool isActive;
        public string activateCriteria;
        public string criteriaDescription;
        public bool criteriaMetAtCurrentPosition;
    }

    [Serializable]
    public class ArrangementBonusInfo
    {
        public int id;
        public string name;
        public string description;
        public bool isActive;
    }

    [Serializable]
    public class SetEffectInfo
    {
        public string name;
        public int count;
        public int maxCount;
    }

    // ── Map & Dungeon Data Models ──────────────────────────────────

    [Serializable]
    public class MapData
    {
        public string stageName;
        public string floorName;
        public int floorSeed;
        public PlayerPos playerPos = new PlayerPos();
        public List<RoomInfo> rooms = new List<RoomInfo>();
    }

    [Serializable]
    public class PlayerPos
    {
        public float x;
        public float y;
        public int currentRoomId;
    }

    [Serializable]
    public class RoomInfo
    {
        public int id;
        public int gridX;
        public int gridY;
        public int sizeX;
        public int sizeY;
        public float worldBottomLeftX;
        public float worldBottomLeftY;
        public float worldTopRightX;
        public float worldTopRightY;
        public string purpose;       // "Entrance", "Exit", "Combat", "Essential", "Event", "Hidden", "Corridor"
        public string roomType;      // "ONE", "TWO_H", "TWO_V", "FOUR"
        public bool isRevealed;
        public bool isCurrentRoom;
    }

    // ── Commands from Dashboard ────────────────────────────────────

    [Serializable]
    public class DashboardCommand
    {
        public string type;  // "optimize", "refresh", "apply"
        public int seq;      // 요청 일련번호 (재시작 시 옛 응답 구분용)
    }

    /// <summary>반영하기: 아이템 하나의 목표 상태 (선형 인덱스 + 석판 회전)</summary>
    [Serializable]
    public class ApplyMove
    {
        public int iid;   // instanceID
        public int idx;   // 목표 칸 (y * width + x)
        public int rot;   // 목표 회전 0..3 (석판만 의미 있음)
    }

    // ── Lightweight JSON Helper ────────────────────────────────────

    internal static class JsonHelper
    {
        public static string ToJson(InventorySnapshot snapshot)
        {
            var sb = new StringBuilder(4096);
            sb.Append('{');
            AppendString(sb, "type", snapshot.type);
            sb.Append(',');
            sb.Append("\"data\":");
            SerializeInventoryData(sb, snapshot.data);
            sb.Append('}');
            return sb.ToString();
        }

        public static string ToJson(MapSnapshot snapshot)
        {
            var sb = new StringBuilder(4096);
            sb.Append('{');
            AppendString(sb, "type", snapshot.type);
            sb.Append(',');
            sb.Append("\"data\":");
            SerializeMapData(sb, snapshot.data);
            sb.Append('}');
            return sb.ToString();
        }


        public static DashboardCommand ParseCommand(string json)
        {
            var cmd = new DashboardCommand();
            cmd.type = ExtractStringValue(json, "type");
            cmd.seq = ExtractIntValue(json, "seq");
            return cmd;
        }

        /// <summary>apply 명령의 moves 배열을 파싱한다.</summary>
        public static List<ApplyMove> ParseApplyMoves(string json)
        {
            var moves = new List<ApplyMove>();

            int arrKey = json.IndexOf("\"moves\"");
            if (arrKey < 0) return moves;
            int arrStart = json.IndexOf('[', arrKey);
            int arrEnd = json.IndexOf(']', arrStart);
            if (arrStart < 0 || arrEnd < 0) return moves;

            string content = json.Substring(arrStart + 1, arrEnd - arrStart - 1);
            foreach (var chunk in content.Split(new[] { "},{" }, StringSplitOptions.RemoveEmptyEntries))
            {
                string obj = "{" + chunk.Trim().TrimStart('{').TrimEnd('}') + "}";
                moves.Add(new ApplyMove
                {
                    iid = ExtractIntValue(obj, "iid"),
                    idx = ExtractIntValue(obj, "idx"),
                    rot = ExtractIntValue(obj, "rot"),
                });
            }
            return moves;
        }


        // ── Serialization Helpers ─────────────────────────────────

        private static void SerializeInventoryData(StringBuilder sb, InventoryData data)
        {
            sb.Append('{');
            AppendInt(sb, "width", data.width); sb.Append(',');
            AppendInt(sb, "height", data.height); sb.Append(',');
            AppendInt(sb, "storage", data.storage); sb.Append(',');
            AppendFloat(sb, "currentScore", data.currentScore); sb.Append(',');

            sb.Append("\"items\":[");
            for (int i = 0; i < data.items.Count; i++)
            {
                if (i > 0) sb.Append(',');
                SerializeCharmItem(sb, data.items[i]);
            }
            sb.Append("],");

            sb.Append("\"arrangementBonuses\":[");
            for (int i = 0; i < data.arrangementBonuses.Count; i++)
            {
                if (i > 0) sb.Append(',');
                SerializeArrangementBonus(sb, data.arrangementBonuses[i]);
            }
            sb.Append("],");

            sb.Append("\"setEffects\":[");
            for (int i = 0; i < data.setEffects.Count; i++)
            {
                if (i > 0) sb.Append(',');
                SerializeSetEffect(sb, data.setEffects[i]);
            }
            sb.Append(']');

            sb.Append('}');
        }

        private static void SerializeMapData(StringBuilder sb, MapData map)
        {
            sb.Append('{');
            AppendString(sb, "stageName", map.stageName); sb.Append(',');
            AppendString(sb, "floorName", map.floorName); sb.Append(',');
            AppendInt(sb, "floorSeed", map.floorSeed); sb.Append(',');

            sb.Append("\"playerPos\":{");
            AppendFloat(sb, "x", map.playerPos.x); sb.Append(',');
            AppendFloat(sb, "y", map.playerPos.y); sb.Append(',');
            AppendInt(sb, "currentRoomId", map.playerPos.currentRoomId);
            sb.Append("},");

            sb.Append("\"rooms\":[");
            for (int i = 0; i < map.rooms.Count; i++)
            {
                if (i > 0) sb.Append(',');
                SerializeRoomInfo(sb, map.rooms[i]);
            }
            sb.Append(']');
            sb.Append('}');
        }

        private static void SerializeRoomInfo(StringBuilder sb, RoomInfo r)
        {
            sb.Append('{');
            AppendInt(sb, "id", r.id); sb.Append(',');
            AppendInt(sb, "gridX", r.gridX); sb.Append(',');
            AppendInt(sb, "gridY", r.gridY); sb.Append(',');
            AppendInt(sb, "sizeX", r.sizeX); sb.Append(',');
            AppendInt(sb, "sizeY", r.sizeY); sb.Append(',');
            AppendFloat(sb, "worldBottomLeftX", r.worldBottomLeftX); sb.Append(',');
            AppendFloat(sb, "worldBottomLeftY", r.worldBottomLeftY); sb.Append(',');
            AppendFloat(sb, "worldTopRightX", r.worldTopRightX); sb.Append(',');
            AppendFloat(sb, "worldTopRightY", r.worldTopRightY); sb.Append(',');
            AppendString(sb, "purpose", r.purpose); sb.Append(',');
            AppendString(sb, "roomType", r.roomType); sb.Append(',');
            AppendBool(sb, "isRevealed", r.isRevealed); sb.Append(',');
            AppendBool(sb, "isCurrentRoom", r.isCurrentRoom);
            sb.Append('}');
        }

        private static void SerializeCharmItem(StringBuilder sb, CharmItemInfo item)
        {
            sb.Append('{');
            AppendInt(sb, "instanceID", item.instanceID); sb.Append(',');
            AppendInt(sb, "entityID", item.entityID); sb.Append(',');
            AppendString(sb, "name", item.name); sb.Append(',');
            AppendInt(sb, "x", item.x); sb.Append(',');
            AppendInt(sb, "y", item.y); sb.Append(',');
            AppendInt(sb, "level", item.level); sb.Append(',');
            AppendInt(sb, "maxLevel", item.maxLevel); sb.Append(',');
            AppendString(sb, "category", item.category); sb.Append(',');
            AppendString(sb, "color", item.color); sb.Append(',');
            AppendString(sb, "rarity", item.rarity); sb.Append(',');
            AppendBool(sb, "isActive", item.isActive); sb.Append(',');
            AppendString(sb, "activateCriteria", item.activateCriteria); sb.Append(',');
            AppendString(sb, "criteriaDescription", item.criteriaDescription); sb.Append(',');
            AppendBool(sb, "criteriaMetAtCurrentPosition", item.criteriaMetAtCurrentPosition);
            sb.Append('}');
        }

        private static void SerializeArrangementBonus(StringBuilder sb, ArrangementBonusInfo bonus)
        {
            sb.Append('{');
            AppendInt(sb, "id", bonus.id); sb.Append(',');
            AppendString(sb, "name", bonus.name); sb.Append(',');
            AppendString(sb, "description", bonus.description); sb.Append(',');
            AppendBool(sb, "isActive", bonus.isActive);
            sb.Append('}');
        }

        private static void SerializeSetEffect(StringBuilder sb, SetEffectInfo effect)
        {
            sb.Append('{');
            AppendString(sb, "name", effect.name); sb.Append(',');
            AppendInt(sb, "count", effect.count); sb.Append(',');
            AppendInt(sb, "maxCount", effect.maxCount);
            sb.Append('}');
        }


        private static void AppendString(StringBuilder sb, string key, string value)
        {
            sb.Append('"').Append(key).Append("\":\"").Append(EscapeJson(value ?? "")).Append('"');
        }

        private static void AppendInt(StringBuilder sb, string key, int value)
        {
            sb.Append('"').Append(key).Append("\":").Append(value);
        }

        private static void AppendFloat(StringBuilder sb, string key, float value)
        {
            sb.Append('"').Append(key).Append("\":").Append(value.ToString("F1"));
        }

        private static void AppendBool(StringBuilder sb, string key, bool value)
        {
            sb.Append('"').Append(key).Append("\":").Append(value ? "true" : "false");
        }

        private static string EscapeJson(string s)
        {
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"")
                    .Replace("\n", "\\n").Replace("\r", "\\r")
                    .Replace("\t", "\\t");
        }

        private static string ExtractStringValue(string json, string key)
        {
            string search = "\"" + key + "\"";
            int idx = json.IndexOf(search);
            if (idx < 0) return "";
            int colonIdx = json.IndexOf(':', idx + search.Length);
            if (colonIdx < 0) return "";
            int quoteStart = json.IndexOf('"', colonIdx + 1);
            if (quoteStart < 0) return "";
            int quoteEnd = json.IndexOf('"', quoteStart + 1);
            if (quoteEnd < 0) return "";
            return json.Substring(quoteStart + 1, quoteEnd - quoteStart - 1);
        }

        private static int ExtractIntValue(string json, string key)
        {
            string search = "\"" + key + "\"";
            int idx = json.IndexOf(search);
            if (idx < 0) return 0;
            int colonIdx = json.IndexOf(':', idx + search.Length);
            if (colonIdx < 0) return 0;
            int start = colonIdx + 1;
            while (start < json.Length && json[start] == ' ') start++;
            int end = start;
            while (end < json.Length && (char.IsDigit(json[end]) || json[end] == '-')) end++;
            if (int.TryParse(json.Substring(start, end - start), out int result))
                return result;
            return 0;
        }
    }
}
