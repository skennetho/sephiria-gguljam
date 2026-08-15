=====================================================
 Sephiria Tools - 배치 최적화 & 위키 빌드 오버레이
=====================================================

세피리아 게임 화면 위에 뜨는 오버레이입니다.
 - 아티팩트 최적 배치 계산 (석판 효과·발동조건 반영)
 - sephiria.wiki 빌드 브라우저 + 즐겨찾기
 - 게임을 읽기만 하며, 게임 파일이나 세이브를 변경하지 않습니다.


■ 설치 (최초 1회)

  1. 게임을 종료합니다.
  2. Install.bat 을 더블클릭합니다.
     - Sephiria 설치 폴더를 자동으로 찾아 BepInEx·플러그인·오버레이를
       게임 폴더 안에 설치합니다.
     - 이미 BepInEx 를 쓰고 있다면 플러그인만 추가됩니다.
  3. 설치가 끝나면 이 압축 푼 폴더는 지워도 됩니다.

  * "Windows 의 PC 보호" 파란 창이 뜨면: 추가 정보 → 실행.
    코드 서명이 없는 개인 배포판이라 뜨는 경고입니다.


■ 실행

  그냥 게임을 켜면 됩니다.
   → 오버레이가 자동으로 함께 뜨고, 게임을 끄면 자동으로 닫힙니다.
   → 수동으로 다시 띄우려면(Ctrl+Q 로 닫은 뒤 등):
      게임폴더\BepInEx\plugins\SephiriaTools\Overlay      Sephiria Tools Overlay.exe

  자동 실행을 끄려면:
   게임폴더\BepInEx\config\com.sephiria.tools.cfg 에서
   [Overlay] AutoLaunch = false

  ! 게임 그래픽 설정에서 화면 모드를
    "테두리 없는 창(Borderless)" 으로 설정하세요.
    독점 전체화면에서는 오버레이가 보이지 않습니다.


■ 단축키

  Ctrl+D   최적 배치 패널 (새로고침 → 계산 → 배치 따라하기)
  Ctrl+R   최적 배치 계산 실행
  Ctrl+B   위키 빌드 브라우저 (카드의 ☆ = 즐겨찾기)
  F1       팀원 빌드 패널 (멀티플레이, 준비 중)
  Ctrl+H   하단 단축키 바 숨기기/보이기
  Ctrl+Q   오버레이 종료
  

■ 문제가 생기면

  - 오버레이가 안 보임: 게임을 '테두리 없는 창' 으로 바꿨는지 확인
  - "게임 연결 끊김": 게임을 켠 뒤 잠시 기다리면 자동 재접속됩니다.
    계속되면 게임 폴더\BepInEx\LogOutput.log 를 확인하세요.
  - 오버레이 로그: 게임폴더\BepInEx\plugins\SephiriaTools\Overlay\overlay.log
■ 삭제 및 원복

  Uninstall.bat 을 더블클릭하면 Sephiria Tools 가 삭제되고 게임이 원래 상태로 복원됩니다.
  (수동 삭제: 게임 폴더에서 winhttp.dll 과 BepInEx 폴더 삭제)


■ 포함물 라이선스

  BepInEx (LGPL-2.1) 를 동봉합니다.
  https://github.com/BepInEx/BepInEx
