using BepInEx;
using HarmonyLib;
using System;
using System.IO;
using UnityEngine;

namespace SephiriaTools
{
    [BepInPlugin("com.sephiria.tools", "SephiriaTools", "0.3.0")]
    public class Plugin : BaseUnityPlugin
    {
        public static Plugin Instance { get; private set; }
        internal static BepInEx.Logging.ManualLogSource Log;

        private SimpleWebSocketServer _wsServer;
        private DataCollector _dataCollector;

        private BepInEx.Configuration.ConfigEntry<int> _cfgPort;
        private BepInEx.Configuration.ConfigEntry<string> _cfgAssetsDir;
        private BepInEx.Configuration.ConfigEntry<bool> _cfgOverlayAutoLaunch;
        private BepInEx.Configuration.ConfigEntry<string> _cfgOverlayExePath;

        private void Awake()
        {
            Instance = this;
            Log = Logger;

            Log.LogInfo("Plugin SephiriaTools is loaded!");

            _cfgPort = Config.Bind("Server", "Port", 5827,
                "Port for the WebSocket server the dashboard/overlay connect to.");
            _cfgAssetsDir = Config.Bind("Export", "AssetsDir", "",
                "Directory to export icons and database.json/js into. " +
                "Leave empty to export next to the plugin DLL (BepInEx/plugins/SephiriaTools/assets). " +
                "Point this at <repo>/assets to feed the dashboard and overlay directly.");
            _cfgOverlayAutoLaunch = Config.Bind("Overlay", "AutoLaunch", true,
                "Launch the overlay app automatically when the game starts. " +
                "The overlay closes itself when the game exits.");
            _cfgOverlayExePath = Config.Bind("Overlay", "ExePath", "",
                "Path to the overlay executable. Leave empty to use the default install " +
                "location next to the plugin DLL (Overlay/Sephiria Tools Overlay.exe).");

            try
            {
                var harmony = new Harmony("com.sephiria.tools");
                harmony.PatchAll();
                Log.LogInfo("Harmony patches applied successfully.");
            }
            catch (Exception ex)
            {
                Log.LogError($"Harmony patch failed: {ex.Message}");
            }

            try
            {
                _wsServer = new SimpleWebSocketServer(_cfgPort.Value);
                _wsServer.Start();
                Log.LogInfo($"WebSocket server started on ws://localhost:{_cfgPort.Value}");

                _dataCollector = new DataCollector(_wsServer);
            }
            catch (Exception ex)
            {
                Log.LogError($"Failed to start WebSocket server: {ex.Message}");
            }
        }

        private void Start()
        {
            TryExport();
            TryLaunchOverlay();
        }

        /// <summary>
        /// 게임이 켜질 때 오버레이를 함께 띄운다.
        ///
        /// 게임을 어떤 경로로 실행하든(스팀·바로가기) 플러그인은 반드시 함께 뜨므로
        /// 여기가 자동 실행의 유일하게 확실한 지점이다. 상주 프로세스도 필요 없다.
        /// 오버레이는 게임 종료를 감지하면 스스로 닫히므로 수명이 게임과 일치한다.
        ///
        /// 실패해도 게임에는 아무 영향이 없어야 하므로 전부 조용히 넘어간다.
        /// </summary>
        private void TryLaunchOverlay()
        {
            try
            {
                if (!_cfgOverlayAutoLaunch.Value) return;

                string exePath = _cfgOverlayExePath.Value;
                if (string.IsNullOrEmpty(exePath))
                {
                    string pluginDir = Path.GetDirectoryName(Info.Location) ?? Paths.PluginPath;
                    exePath = Path.Combine(pluginDir, "Overlay", "Sephiria Tools Overlay.exe");
                }

                if (!File.Exists(exePath))
                {
                    Log.LogInfo($"오버레이 자동 실행 건너뜀 - exe 없음: {exePath}");
                    return;
                }

                // 이미 떠 있으면 다시 띄우지 않는다.
                // (오버레이 자체도 single-instance lock 이 있어 이중 안전장치다)
                var running = System.Diagnostics.Process.GetProcessesByName("Sephiria Tools Overlay");
                if (running != null && running.Length > 0)
                {
                    Log.LogInfo("오버레이가 이미 실행 중 - 자동 실행 건너뜀");
                    return;
                }

                var psi = new System.Diagnostics.ProcessStartInfo
                {
                    FileName = exePath,
                    WorkingDirectory = Path.GetDirectoryName(exePath),
                    UseShellExecute = true,
                };
                System.Diagnostics.Process.Start(psi);
                Log.LogInfo($"오버레이 자동 실행: {exePath}");
            }
            catch (Exception ex)
            {
                Log.LogWarning($"오버레이 자동 실행 실패 (게임에는 영향 없음): {ex.Message}");
            }
        }

        private void Update()
        {
            _dataCollector?.Update();

            CheckInGameHotkeys();

            // Retry export every few seconds if items were not loaded yet on title screen
            if (Time.frameCount % 180 == 0)
            {
                TryExport();
            }
        }

        private void CheckInGameHotkeys()
        {
            if (_wsServer == null || !_wsServer.HasClients) return;

            bool ctrl = Input.GetKey(KeyCode.LeftControl) || Input.GetKey(KeyCode.RightControl);

            if (ctrl && Input.GetKeyDown(KeyCode.D))
            {
                _wsServer.Broadcast("{\"type\":\"hotkey\",\"action\":\"toggle-optimizer\"}");
            }
            else if (ctrl && Input.GetKeyDown(KeyCode.B))
            {
                _wsServer.Broadcast("{\"type\":\"hotkey\",\"action\":\"toggle-builds\"}");
            }
            else if (Input.GetKeyDown(KeyCode.F1))
            {
                _wsServer.Broadcast("{\"type\":\"hotkey\",\"action\":\"toggle-team\"}");
            }
            else if (ctrl && Input.GetKeyDown(KeyCode.R))
            {
                _wsServer.Broadcast("{\"type\":\"hotkey\",\"action\":\"run-optimize\"}");
            }
            else if (ctrl && Input.GetKeyDown(KeyCode.H))
            {
                _wsServer.Broadcast("{\"type\":\"hotkey\",\"action\":\"toggle-hotkey-bar\"}");
            }
            else if (ctrl && Input.GetKeyDown(KeyCode.Comma))
            {
                _wsServer.Broadcast("{\"type\":\"hotkey\",\"action\":\"toggle-settings\"}");
            }
        }

        internal void TryExport()
        {
            try
            {
                string assetsDir = _cfgAssetsDir.Value;

                if (string.IsNullOrEmpty(assetsDir))
                {
                    assetsDir = Path.Combine(
                        Path.GetDirectoryName(Info.Location) ?? Paths.PluginPath,
                        "assets");
                }

                if (!Directory.Exists(assetsDir))
                {
                    Directory.CreateDirectory(assetsDir);
                }

                ResourceExporter.ExportAllResources(assetsDir);
            }
            catch (Exception ex)
            {
                Log.LogWarning($"Resource export notice: {ex.Message}");
            }
        }

        private void OnDestroy()
        {
            _wsServer?.Stop();
            Log.LogInfo("SephiriaTools plugin unloaded.");
        }
    }
}
