# 게임/위키 데이터 조사 결과

> 2026-08-14. M1(최적 배치)·M2(빌드 브라우저) 구현의 근거 자료.
> 위키 재수집: `node scripts/fetch-wiki-data.mjs`
> 게임 재추출: 플러그인이 실행 중 자동으로 `assets/database.json` 갱신
>
> **상세 구현 스펙은 [OPTIMIZER-SPEC.md](OPTIMIZER-SPEC.md)** (디컴파일 근거 인용 포함)

## 0. 게임에서 실제 추출한 데이터 (권위 있는 출처)

플러그인 추출기를 고친 뒤 실측한 결과:

| 항목 | 수치 |
|------|------|
| 총 아이템 | 444 (참 338 · 석판 69 · 포션 32 · 투척 3 · 스크롤 2) |
| 콤보 카테고리 | 22 (그중 PARTY·WEAPON 은 `isEnabled=false` = 미사용) |
| 콤보 소속 참 | 269 / 338 |
| 석판 | 69개 · 회전 가능 48 · 자체 발동조건 보유 4 |
| 현지화된 이름 | 거의 전부 (일부 미번역 키 잔존) |

**위키 대비 격차 7개**로 축소 (표기 차이 수준: "엔도디트" vs "엔도디토" 등).

### 추출기에서 고친 버그

1. `_hasExported` 플래그가 첫 성공에 영구 고정 → 타이틀 화면의 **41개만** 남고 끝남. 지문 기반 재추출로 교체.
2. 씬 전환 시 일부 언로드로 개수가 **줄어드는** 재추출이 더 큰 덤프를 덮어씀 → 누적(합집합) 방식으로 교체.
3. `Encoding.UTF8` 이 **BOM** 을 붙여 `JSON.parse`/`fetch().json()` 가 깨짐 → BOM 없는 UTF-8.
4. ID 범위(1000~2999)로 필터 → **EItemType** 기준으로 교체. 범위 밖 참/석판과 빌드에 등장하는 포션이 빠져 있었음.
5. `aName` 을 직접 읽어 마법서가 껍데기 이름으로 나옴 → `ItemEntity.Name` 사용 (마법서는 담긴 마법 이름을 반환).

### 새로 추출되는 필드

참: `maxLevel`, `criteria`(발동조건 클래스명), `categories`(콤보 소속), `isMagicBook`
석판: `query`, `conditionQuery`, `isRotatable`
콤보: `comboTiers`(진짜 콤보 단계), `setTiers`(별개의 세트 효과), `isEnabled`

### 실측 통계

- 발동조건 보유 참은 **15개뿐**: TopInInventory 4, BottomInInventory 4, Outlined 3, Inside 2, BothSidesAreEmpty 1, BothSideCharm 1
  → 현재 옵티마이저가 틀리게 구현한 조건(Bottom/Inside/Outlined)과 아예 빠뜨린 조건(BothSidesAreEmpty/BothSideCharm)이 **실제로 쓰이고 있다.**
- 석판 쿼리 키워드 실사용 빈도:
  `UP(36) RIGHT(20) LEFT(17) DOWN(17) DIAUPLEFT(16) DIAUPRIGHT(11) UPUP(8) DIADOWNRIGHT(7) HORIZONTAL(6) DIADOWNLEFT(6) VERTICAL(4) KNIGHTUPLEFT(3) DOWNDOWN(3) UPUPUP(3) CHECKERBOARD2(3) CHECKERBOARD(3) BOTTOM(2) RIGHTRIGHT(2) RIGHTRIGHTRIGHT(2) RIDX(2) TOP(1) RIGHT_RISING(1) LEFT_FALLING(1) LEFT_RISING(1) RIGHT_FALLING(1) O(1)`
- `maxLevel` 분포: 0:29, 1:23, 2:90, 3:80, 4:69, 5:28, 6:10, 7:4, 10:1, 14:1

### 인챈트 vs maxLevel

플레이어가 올리는 **인챈트는 0~5강**이고, 석판이 그 위에 `+@` 를 얹는다.
`Charm_Basic.maxLevel`(기본값 5, 실제로는 0~14로 다양)은 그와 별개로
**효과 계산에 쓰이는 레벨의 상한**이다. 상한을 넘긴 레벨은 발동에는 지장이 없고
효과 수치에서만 잘린다.

위키의 `level` 필드와 게임의 `maxLevel` 은 이름 매칭된 241개 중 **239개가 일치**(99.2%)해,
둘이 같은 값임이 교차 검증됐다.

## 1. 확정된 사실

### 1-1. 콤보 단계는 **개수**로 결정된다 (강화수 무관)

위키 콤보 페이지 명시: *"아티팩트 보유 개수에 따라 효과가 활성화됩니다"*

이것이 목적함수 설계의 핵심 전제다:

- **콤보 단계** = 해당 콤보 소속 아티팩트를 몇 개 들고 있는가 → **배치와 무관**(인벤에 있기만 하면 됨)
- **개별 아티팩트 효과** = 그 아티팩트의 강화수에 따라 커짐 → **배치로 좌우됨**(석판 보너스)

따라서 "콤보템 최대강화" 모드의 의미는 *콤보 단계를 올리는 것*이 아니라,
**이미 확보된 콤보 소속 아티팩트들의 강화수를 석판 배치로 최대화**하는 것이다.

### 1-2. 콤보 20종 (위키 슬러그 ↔ 아이콘 ↔ 한글명)

| 한글 | 위키 슬러그 | 아이콘 | 소속 아티팩트 | 단계 |
|------|------------|--------|-------------|------|
| 잉걸불 | `yinggalbul` | EMBER | 22 | 2~10 |
| 얼음무구 | `ice_weapon` | FROST | 11 | 2~10 |
| 빙하 | `glacier` | GLACIER | 19 | 2~10 |
| 마법공학 | `magic_engineering` | MAGITECH | 16 | 2~10 |
| 그림자 | `shadow` | SHADOW | 12 | 2~10 |
| 수호 | `guardian` | GUARDIAN | 14 | 2~10 |
| 바람노래 | `spring_song` | WINDSONG | 20 | 2~10 |
| 신비 | `mystery` | MYSTIC | 11 | 2~4 |
| 행성 | `planet` | PLANET | 10 | 2~10 |
| 동료 | `colleague` | COMPANION | 13 | 2~10 |
| 정밀 | `precision` | PRECISION | 21 | 2~10 |
| 먹구름 | `extrium` | DARKCLOUD | 16 | 2~10 |
| 견고 | `firmness` | STURDY | 27 | 2~10 |
| 호수 | `lake` | LAKE | 17 | 3~9 |
| 태양검 | `sun_sword` | FLAMESWORD | 11 | 2~10 |
| 아카데미 | `academy` | ACADEMY | 19 | 2~10 |
| 저주 | `curse` | CURSE | 5 | 2~4 |
| 교섭 | `bargaining` | SAVVY | 3 | 2~4 |
| 원소 | `element` | ELEMENTAL | 5 | 2~6 |
| 연금술 | `alchemy` | ALCHEMY | 4 | 1~3 |

슬러그↔한글 대응은 소속 아티팩트의 `effect.content` 키워드 빈도로 실증 확인했다
(예: `extrium` 소속 16개 아티팩트 설명에 "먹구름" 19회 등장 → 먹구름 확정).

`assets/combos/` 의 아이콘 22개 중 위키 콤보 페이지에는 20종만 있다.
**PARTY, WEAPON 은 게임에서 `isEnabled = false`** — 미사용 콤보라 위키에도 없다. (해결됨)

주의: 게임의 `ItemCategoryEntity.setStatus` 임계값(2/3/4/5/6)은 위키의 콤보 단계(2/4/6/8/10)와
다르다. 둘은 **별개 메커니즘**이며, 위키와 대응하는 것은 `comboEffectPrefab` 안의
`ComboEffectBase.addStatByCombo` 쪽이다. 추출기는 이제 둘 다 `comboTiers`/`setTiers` 로 내보낸다.

### 1-3. 석판(StoneTablet)은 "인접 4칸 +1"이 아니다

`StoneTablet` 디컴파일 결과, 석판은 **상대좌표별 효과 패턴**을 가진다:

```
AdditionEffectData { position(상대좌표), effectType, levelParam,
                     isXWorldPosition, isYWorldPosition,
                     borderTop, borderRight, borderBottom, borderLeft }

EffectType  = None | IncreaseConstLevel | Disable | IgnoreCriteria | MultiplyConstLevel
CriteriaType= None | AnyItem | OnlyCharm | Placed   (석판 자신의 발동조건)
```

즉 석판마다 영향 범위·수치·종류가 다르고, 레벨을 **깎거나(Disable)**, **곱하거나
(MultiplyConstLevel)**, **발동조건을 무시(IgnoreCriteria)** 시키기도 한다.

→ 현재 `CustomArrangementOptimizer.ApplyVirtualTabletLevels()` 의
`인접 4칸 +1` 하드코딩은 **전면 오류**. 재작성 대상.

### 1-4. 발동조건은 10종 (현재 5종만 구현)

게임에 존재하는 `CharmActivateCriteria_*`:

| 클래스 | 현재 구현 | 비고 |
|--------|----------|------|
| `TopInInventory` | ✅ | |
| `BottomInInventory` | ✅ | |
| `Inside` | ✅ | |
| `Outlined` | ✅ | |
| `SideEnd` | ✅ | |
| `BothSideCharm` | ❌ | 좌우에 참(charm)이 있어야 함 |
| `BothSidesAreEmpty` | ❌ | 좌우가 비어야 함 |
| `NeighborsAreFull` | ❌ | 인접칸이 모두 차야 함 |
| `Near8MagicBook` | ❌ | 주변 8칸에 마법서 |
| `FullHP` | ❌ | **배치와 무관**(런타임 HP) — 최적화 대상 아님, 고정 입력으로 처리 |

미구현 5종은 현재 `default: return true` 로 **무조건 활성으로 오판**하고 있다.
`BothSidesAreEmpty` 처럼 인접 상태에 의존하는 조건은 배치에 직접 영향을 주므로
최적화 결과가 실제와 어긋난다.

## 2. 수집한 데이터 파일

| 파일 | 내용 |
|------|------|
| `assets/wiki/wikidata.json` | 아티팩트 267 · 무기 158 · 기적 21 (슬러그, 한글명, 등급, 콤보 소속, 강화 스케일링, 아이콘 URL) |
| `assets/wiki/slugs.json` | 슬러그 → 한글명 (경량판) |
| `assets/wiki/combos.json` | 콤보 20종 단계별 효과 + 슬러그/아이콘 매핑 |

### 아티팩트 레코드 예시

```json
{
  "id": 8,
  "value": "windpool_shawl",
  "label_kor": "바람풀 목도리",
  "tier": "common",
  "effect": {
    "sets": ["spring_song"],
    "content": "[고유] 대시 공격 피해 +30/45/60/80%"
  },
  "image": "https://img.sephiria.wiki/artifacts/windpool_shawl.png",
  "level": 3
}
```

- `effect.sets` = 콤보 소속 (복수 가능)
- `effect.content` 의 `a/b/c/d` = **강화 단계별 수치** → 강화 1단계의 실제 가치를 계산 가능
- `level` = 최대 강화수로 추정. 267개 중 233개에서 `수열 항수 == level+1` 성립
  (32개는 수치 수열 없음, 2개 불일치). **게임 데이터(`Charm_Basic.maxLevel`)가 최종 권위** —
  위키 값은 교차검증용으로만 쓴다.
- 콤보 미소속 아티팩트 21개 존재.

## 3. 위키 빌드 API (M2)

```
GET https://www.sephiria.wiki/api/builds?page=1&limit=10&like=desc&isLatestVersion=false&weapon=<슬러그>&isWriter=true
```

응답 필드: `title`, `description`(HTML), `costume`/`weapon`/`miracle`(슬러그), `combo[]`,
`fruit_skewer[{key,value}]`, `ability{base,will,anger,rapid,wisdom,patience,survival}`,
`version`, `content[{label, description, items[{id,value}]}]`, `postLike`, `writer`, 날짜.

- **그리드 배치 정보 없음** → 아이템 리스트 중심 UI (기획 방향과 일치)
- `fruit_skewer` 의 `key` 는 콤보 슬러그와 동일 체계 (`colleague`, `guardian`, `academy` 등)
  이며 음수도 존재(`academy: -2`) → 콤보 단계에 가감되는 보정으로 추정. **확인 필요**
- 위키는 봇 UA 를 403 처리 → 브라우저 UA 필요
- 페이지 데이터는 SSR HTML 이 아니라 RSC flight 페이로드(`self.__next_f.push`) 안에 있음

## 4. 미해결

1. `fruit_skewer`(과일꼬치)가 콤보 단계에 어떻게 반영되는지 — 위키 빌드 데이터에 음수 값도 존재(`academy: -2`)
2. 위키에만 있는 잔여 7개 (표기 차이로 보이나 확인 필요)
3. 게임 내 미번역 키 잔존 (`Item_PlanetComet_Name`)

### 해결됨

- ~~석판 효과 패턴~~ → 텍스트 DSL. `StoneTablet.ParseQuery` 가 `public static` 이라 **직접 호출 가능**
- ~~PARTY/WEAPON 정체~~ → `isEnabled=false` 미사용 콤보
- ~~EvaluateCurrentAutoArrangeScore 의 정체~~ → 게임 자체 목적함수.
  `clamp된레벨합*10000 + 활성수*1000 + 원시레벨합*10 + 초과분 - 비활성수*750 - 음수레벨합*250`
  (단 `[Server]` 전용이라 클라이언트에서는 0 을 반환 — 기준점으로 쓸 수 없음)
