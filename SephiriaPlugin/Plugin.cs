using BepInEx;
using HarmonyLib;
using System;
using System.IO;
using UnityEngine;

namespace SephiriaTools
{
    [BepInPlugin("com.sephiria.tools", "SephiriaTools", "1.0.0")]
    public class Plugin : BaseUnityPlugin
    {
        public static Plugin Instance { get; private set; }
        internal static BepInEx.Logging.ManualLogSource Log;

        private SimpleWebSocketServer _wsServer;
        private DataCollector _dataCollector;

        private BepInEx.Configuration.ConfigEntry<int> _cfgPort;
        private BepInEx.Configuration.ConfigEntry<string> _cfgAssetsDir;

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
        }

        private void Update()
        {
            _dataCollector?.Update();

            // Retry export every few seconds if items were not loaded yet on title screen
            if (Time.frameCount % 180 == 0)
            {
                TryExport();
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
