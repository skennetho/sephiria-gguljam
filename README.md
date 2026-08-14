# 🎮 Sephiria Tools — 인벤토리 배치 최적화 & Awakened PoE Trade 스타일 오버레이 도구

세피리아(Sephiria)의 그리드 인벤토리 시스템 및 실시간 던전 맵을 게임 화면 위에 오버레이로 띄워 최적화하는 BepInEx 플러그인 + **Awakened PoE Trade 스타일 오버레이**입니다.

## 📋 주요 기능

- **Awakened PoE Trade 스타일 퀵 평가 팝업 (`Ctrl + D`)**: 게임 중 단축키를 누르면 게임 화면 중앙 상단에 아티팩트 배치 평가 카드가 팝업되어 원클릭으로 최적 배치 적용!
- **풀 컴패니언 오버레이 (`Shift + Tab`)**: 게임 위에 둥둥 뜨는 전체 인벤토리 그리드 뷰어 & 게임 프로세스 제어 (실행/재시작/강제종료)
- **실시간 던전 미니맵 HUD (`Ctrl + Shift + M`)**: 던전 방 구조 및 플레이어 실시간 위치 레이더 시각화
- **마우스 클릭 투과 (Mouse Passthrough)**: UI 카드가 없는 투명 배경 공간 클릭 시 마우스 클릭이 게임으로 자동 전송!

## 🏗️ 프로젝트 구조

```
SephiriaPlugin/
├── SephiriaPlugin/               # BepInEx 5.x 플러그인 (C#) → SephiriaTools.dll
│   ├── Plugin.cs                 # 진입점, BepInEx 설정 (포트/에셋 경로)
│   ├── DataCollector.cs          # 인벤토리/맵 수집. 읽기 전용
│   ├── OptimizeSnapshot.cs       # 최적화용 상태 + 석판 패턴 해석 (ParseQuery 호출)
│   ├── SimpleWebSocketServer.cs  # WS 서버 (기본 ws://localhost:5827)
│   ├── Models.cs                 # 데이터 모델 + JSON 직렬화
│   └── ResourceExporter.cs       # 게임 아이콘/아이템 DB를 assets/ 로 덤프
│
├── assets/                       # 플러그인이 생성하는 공용 리소스
│   ├── icons/  combos/           # 추출된 PNG
│   ├── database.json / .js       # 아이템 DB (444종: 참·석판·포션 등)
│   └── wiki/                     # 위키에서 수집한 보조 데이터
│
├── overlay/                      # Electron 인게임 오버레이 (주 UI)
│   ├── main.js                   # 투명 윈도우, 전역 단축키, 위키 API 프록시
│   ├── renderer.js               # 패널 UI & WebSocket 연결
│   ├── optimizer.js              # 배치 최적화 엔진 (탐색·점수 계산)
│   ├── optimizer.test.js         # 엔진 단위 테스트 (게임 없이 실행)
│   ├── logger.js                 # 메인/렌더러 공용 파일 로거
│   └── index.html / style.css
│
│
├── scripts/
│   ├── setup.ps1                 # (개발용) BepInEx 설치 + 플러그인 빌드/배포
│   ├── fetch-wiki-data.mjs       # 위키 데이터 수집
│   ├── build-release.mjs         # 배포 zip 생성
│   └── release/                  # 설치기·런처·안내문 (배포판에 포함)
│
└── libs/                         # setup.ps1이 내려받는 BepInEx (git 미추적)
```

### ⚙️ 설정

플러그인 설정은 최초 실행 후 `<게임폴더>\BepInEx\config\com.sephiria.tools.cfg` 에 생성됩니다.

| 항목 | 기본값 | 설명 |
|------|--------|------|
| `Server.Port` | `5827` | 대시보드/오버레이가 접속하는 WebSocket 포트 |
| `Export.AssetsDir` | (비움) | 아이콘·DB 덤프 경로. 비우면 플러그인 DLL 옆 `assets/`. 이 저장소의 `assets/` 를 지정하면 대시보드에 바로 반영됩니다 |

게임이 기본 Steam 경로에 없다면 빌드 시 경로를 넘기세요:

```powershell
dotnet build -c Release -p:GameDir="D:\Games\Sephiria"
```

## 🚀 사용법

### 1단계: 플러그인 설치 (최초 1회)

PowerShell에서 실행:
```powershell
cd SephiriaPlugin
.\scripts\setup.ps1
```

### 2단계: 게임 실행

게임을 켜면 오버레이가 자동으로 함께 뜹니다.
(개발 중 수동 실행: `cd overlay && npx electron .`)
### 3단계: 단축키 사용 가이드

| 단축키 | 기능 설명 |
|--------|-----------|
| **`Ctrl + D`** | 최적 배치 패널 (미니 그리드 · 콤보 우선순위 · 강화 모드) |
| **`Ctrl + B`** | 위키 빌드 브라우저 |
| **`F1`** | 팀원 빌드 패널 |
| **`Ctrl + R`** | 최적 배치 계산 실행 |
| **`Ctrl + H`** | 단축키 안내 바 숨기기 |
| **`Ctrl + Q`** | 오버레이 종료 |
| **`F5`** | 오버레이 UI 새로고침 (개발용, 게임은 건드리지 않음) |

`Esc` 는 의도적으로 등록하지 않는다 — 전역 단축키로 잡으면 게임의 `Esc` 가 먹히지 않는다.

## 🧩 아키텍처

배치 최적화는 **플러그인과 오버레이가 역할을 나눠** 수행한다.

```
게임 ──읽기만──> 플러그인 ──WS──> 오버레이
                  │                 │
                  │                 └─ 탐색 + 점수 계산 (optimizer.js)
                  └─ 상태 스냅샷 + 석판 패턴 해석
```

**플러그인이 하는 일** — 오버레이가 알 수 없는 것만:

1. **석판 효과 해석.** 석판 효과는 47개 키워드짜리 텍스트 DSL 이고 회전마다 분기가 다르다.
   게임의 `StoneTablet.ParseQuery` 를 그대로 호출해 "이 석판을 이 칸에 이 회전으로 놓으면
   어느 칸에 무슨 효과" 까지 풀어서 넘긴다. JS 로 재구현하면 어긋나고 패치 때마다 깨진다.
2. **런타임 상태** — 인챈트 수치, 칸별 임시 레벨, 각인, 회전 가능 여부.

**오버레이가 하는 일** — 탐색과 점수 계산 전부.

이렇게 나눈 이유:

- **게임 접촉면이 읽기 전용으로 최소화된다.** 플러그인에는 Harmony 패치가 없고,
  게임 상태를 바꾸는 코드도 없다.
- **알고리즘을 고칠 때 게임을 재시작할 필요가 없다.** `F5` 로 오버레이만 새로고침하면 된다.
- **게임 없이 테스트할 수 있다**: `node overlay/optimizer.test.js`

### 배치 계산 규칙 (디컴파일로 확인)

```
level(칸) = (기본 + 석판 IncreaseConstLevel 합) × (MultiplyConstLevel 합, 0이면 1)
기본      = 칸의 dungeonTempLevels + 그 칸에 놓인 아이템의 인챈트
발동      = 비활성화 아님 && level >= 0 && (조건무시 || 발동조건 만족)
```

- `MUL` 은 곱이 아니라 **합해서 한 번 곱한다**. `MUL/3` 두 개는 ×6 이지 ×9 가 아니다.
- `maxLevel` 은 효과 계산에만 걸리고 발동 여부에는 영향이 없다.
- 격자는 직사각형이 아니다. `height = ceil(storage / width)` 라 **마지막 줄이 부분적으로만
  존재**할 수 있고, 발동조건 여럿이 줄이 아니라 **선형 인덱스**를 기준으로 판정한다.
- 콤보 단계는 **보유 개수**로 정해지므로 배치로 바꿀 수 없다. 배치가 바꾸는 것은
  각 아티팩트의 최종 강화수뿐이다.

## 📦 배포판 만들기

```powershell
node scripts/build-release.mjs
```

산출물: `dist/SephiriaTools-v<버전>.zip` (약 107MB). 버전은 `overlay/package.json` 의 `version`.

zip 안에는 더블클릭 설치기(`Install.bat`)와 런처(`Sephiria Tools.bat`),
동봉 BepInEx, 플러그인 DLL, 초기 assets, 패키징된 오버레이가 들어간다.

배포판의 assets 해석 순서 (`overlay/assets-locator.js`):
`SEPHIRIA_ASSETS` 환경변수 → 저장소 `assets/`(개발) → 게임 폴더의 플러그인 덤프
→ exe 옆 동봉 스냅샷(`assets-bundled/`). 설치기가 게임 폴더에 assets 를 시드하므로
설치 직후부터 아이콘이 뜨고, 이후 게임이 스스로 갱신한다.

GitHub Releases 에 zip 을 올려 배포한다. 코드 서명이 없으므로 SmartScreen 경고
안내가 README.txt 에 포함돼 있다.
