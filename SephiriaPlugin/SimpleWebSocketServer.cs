using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace SephiriaTools
{
    /// <summary>
    /// Minimal WebSocket server running on a background thread.
    /// No external dependencies — uses only System.Net.Sockets.
    /// Designed to run inside a Unity/BepInEx plugin.
    /// </summary>
    internal class SimpleWebSocketServer
    {
        private readonly int _port;
        private TcpListener _listener;
        private Thread _acceptThread;
        private Thread _sendThread;
        private volatile bool _running;

        private readonly List<WebSocketClient> _clients = new List<WebSocketClient>();
        private readonly object _clientLock = new object();

        // [perf] 송신 큐 — Broadcast() 는 큐에 넣기만 하고 즉시 반환한다.
        // 실제 소켓 Write/Flush 는 백그라운드 _sendThread 에서 처리한다.
        private readonly ConcurrentQueue<byte[]> _sendQueue = new ConcurrentQueue<byte[]>();

        // Incoming commands from dashboard, dispatched on Unity main thread
        private readonly ConcurrentQueue<string> _incomingCommands = new ConcurrentQueue<string>();
        public event Action<string> OnCommandReceived;

        public bool HasClients
        {
            get { lock (_clientLock) return _clients.Count > 0; }
        }

        public SimpleWebSocketServer(int port)
        {
            _port = port;
        }

        public void Start()
        {
            _running = true;
            _listener = new TcpListener(IPAddress.Loopback, _port);
            _listener.Start();

            _acceptThread = new Thread(AcceptLoop)
            {
                IsBackground = true,
                Name = "SephiriaTools-WS"
            };
            _acceptThread.Start();

            // [perf] 백그라운드 송신 스레드 — 메인 스레드의 I/O 블로킹을 완전히 제거한다
            _sendThread = new Thread(SendLoop)
            {
                IsBackground = true,
                Name = "SephiriaTools-WSSend"
            };
            _sendThread.Start();
        }

        public void Stop()
        {
            _running = false;

            lock (_clientLock)
            {
                foreach (var c in _clients) c.Close();
                _clients.Clear();
            }

            try { _listener?.Stop(); } catch { }
        }

        /// <summary>Call from Unity main thread (Update) to dispatch received commands.</summary>
        public void ProcessMessages()
        {
            while (_incomingCommands.TryDequeue(out string cmd))
            {
                try { OnCommandReceived?.Invoke(cmd); }
                catch (Exception ex) { Plugin.Log.LogError($"Command handler error: {ex.Message}"); }
            }
        }

        /// <summary>
        /// [perf] 메인 스레드에서 호출 — 프레임을 인코딩해서 큐에 넣고 즉시 반환한다.
        /// 실제 네트워크 I/O 는 SendLoop() 백그라운드 스레드에서 처리한다.
        /// </summary>
        public void Broadcast(string message)
        {
            byte[] frame = EncodeFrame(message);
            _sendQueue.Enqueue(frame);
        }

        /// <summary>
        /// 백그라운드 송신 루프 — 큐에서 프레임을 꺼내 모든 클라이언트에 전송한다.
        /// TCP 버퍼 지연이나 Electron 측 렌더링 지연이 발생해도
        /// Unity 메인 스레드에는 전혀 영향을 주지 않는다.
        /// </summary>
        private void SendLoop()
        {
            while (_running)
            {
                if (_sendQueue.TryDequeue(out byte[] frame))
                {
                    lock (_clientLock)
                    {
                        for (int i = _clients.Count - 1; i >= 0; i--)
                        {
                            try
                            {
                                _clients[i].Send(frame);
                            }
                            catch
                            {
                                _clients[i].Close();
                                _clients.RemoveAt(i);
                            }
                        }
                    }
                }
                else
                {
                    Thread.Sleep(2);
                }
            }
        }

        // ── Accept loop (background thread) ───────────────────────

        private void AcceptLoop()
        {
            while (_running)
            {
                try
                {
                    if (!_listener.Pending())
                    {
                        Thread.Sleep(50);
                        continue;
                    }

                    var tcp = _listener.AcceptTcpClient();
                    tcp.NoDelay = true;

                    var client = new WebSocketClient(tcp);

                    // Perform WebSocket handshake
                    if (PerformHandshake(client))
                    {
                        lock (_clientLock) _clients.Add(client);
                        Plugin.Log.LogInfo("Dashboard client connected.");

                        // Start read thread for this client
                        var readThread = new Thread(() => ReadLoop(client))
                        {
                            IsBackground = true,
                            Name = "SephiriaTools-WSRead"
                        };
                        readThread.Start();
                    }
                    else
                    {
                        client.Close();
                    }
                }
                catch (Exception ex)
                {
                    if (_running) Plugin.Log.LogError($"Accept error: {ex.Message}");
                }
            }
        }

        private void ReadLoop(WebSocketClient client)
        {
            try
            {
                while (_running && client.IsConnected)
                {
                    string message = DecodeFrame(client);
                    if (message == null)
                    {
                        // Connection closed or error
                        break;
                    }

                    if (!string.IsNullOrEmpty(message))
                    {
                        _incomingCommands.Enqueue(message);
                    }
                }
            }
            catch (Exception ex)
            {
                if (_running)
                    Plugin.Log.LogWarning($"Client read error: {ex.Message}");
            }
            finally
            {
                lock (_clientLock) _clients.Remove(client);
                client.Close();
                Plugin.Log.LogInfo("Dashboard client disconnected.");
            }
        }

        // ── WebSocket handshake ────────────────────────────────────

        private bool PerformHandshake(WebSocketClient client)
        {
            try
            {
                var stream = client.Stream;
                byte[] buffer = new byte[4096];
                int bytesRead = stream.Read(buffer, 0, buffer.Length);
                string request = Encoding.UTF8.GetString(buffer, 0, bytesRead);

                if (!request.Contains("Upgrade: websocket"))
                {
                    // Serve a simple HTML redirect for browsers that navigate directly
                    string httpResponse =
                        "HTTP/1.1 200 OK\r\n" +
                        "Content-Type: text/html\r\n" +
                        "Access-Control-Allow-Origin: *\r\n\r\n" +
                        "<html><body><h3>Sephiria Tools WebSocket Server</h3>" +
                        "<p>Open the dashboard HTML file in your browser instead.</p></body></html>";
                    byte[] responseBytes = Encoding.UTF8.GetBytes(httpResponse);
                    stream.Write(responseBytes, 0, responseBytes.Length);
                    return false;
                }

                // Extract Sec-WebSocket-Key
                string key = null;
                foreach (string line in request.Split('\n'))
                {
                    if (line.StartsWith("Sec-WebSocket-Key:", StringComparison.OrdinalIgnoreCase))
                    {
                        key = line.Substring("Sec-WebSocket-Key:".Length).Trim();
                        break;
                    }
                }

                if (key == null) return false;

                // Compute accept key
                string acceptKey = ComputeAcceptKey(key);

                string response =
                    "HTTP/1.1 101 Switching Protocols\r\n" +
                    "Upgrade: websocket\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Sec-WebSocket-Accept: " + acceptKey + "\r\n\r\n";

                byte[] responseData = Encoding.UTF8.GetBytes(response);
                stream.Write(responseData, 0, responseData.Length);
                stream.Flush();

                return true;
            }
            catch (Exception ex)
            {
                Plugin.Log.LogError($"Handshake failed: {ex.Message}");
                return false;
            }
        }

        private string ComputeAcceptKey(string key)
        {
            const string MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
            using (var sha1 = SHA1.Create())
            {
                byte[] hash = sha1.ComputeHash(Encoding.UTF8.GetBytes(key + MAGIC));
                return Convert.ToBase64String(hash);
            }
        }

        // ── WebSocket frame encoding/decoding ──────────────────────

        private static byte[] EncodeFrame(string message)
        {
            byte[] payload = Encoding.UTF8.GetBytes(message);
            byte[] frame;

            if (payload.Length < 126)
            {
                frame = new byte[2 + payload.Length];
                frame[0] = 0x81; // FIN + Text opcode
                frame[1] = (byte)payload.Length;
                Array.Copy(payload, 0, frame, 2, payload.Length);
            }
            else if (payload.Length <= 65535)
            {
                frame = new byte[4 + payload.Length];
                frame[0] = 0x81;
                frame[1] = 126;
                frame[2] = (byte)((payload.Length >> 8) & 0xFF);
                frame[3] = (byte)(payload.Length & 0xFF);
                Array.Copy(payload, 0, frame, 4, payload.Length);
            }
            else
            {
                frame = new byte[10 + payload.Length];
                frame[0] = 0x81;
                frame[1] = 127;
                long len = payload.Length;
                for (int i = 0; i < 8; i++)
                    frame[9 - i] = (byte)(len >> (8 * i));
                Array.Copy(payload, 0, frame, 10, payload.Length);
            }

            return frame;
        }

        private static string DecodeFrame(WebSocketClient client)
        {
            var stream = client.Stream;

            // Read first 2 bytes
            byte[] header = new byte[2];
            if (!ReadExact(stream, header, 2)) return null;

            int opcode = header[0] & 0x0F;
            bool isMasked = (header[1] & 0x80) != 0;
            long payloadLen = header[1] & 0x7F;

            // Close frame
            if (opcode == 0x08) return null;

            // Ping → send pong
            if (opcode == 0x09)
            {
                byte[] pong = new byte[2];
                pong[0] = 0x8A; // Pong
                pong[1] = 0;
                stream.Write(pong, 0, 2);
                return "";
            }

            // Extended payload length
            if (payloadLen == 126)
            {
                byte[] ext = new byte[2];
                if (!ReadExact(stream, ext, 2)) return null;
                payloadLen = (ext[0] << 8) | ext[1];
            }
            else if (payloadLen == 127)
            {
                byte[] ext = new byte[8];
                if (!ReadExact(stream, ext, 8)) return null;
                payloadLen = 0;
                for (int i = 0; i < 8; i++)
                    payloadLen = (payloadLen << 8) | ext[i];
            }

            // Mask key (client → server is always masked)
            byte[] mask = null;
            if (isMasked)
            {
                mask = new byte[4];
                if (!ReadExact(stream, mask, 4)) return null;
            }

            // Payload
            if (payloadLen > 1024 * 1024) return null; // Safety limit: 1MB
            byte[] payload = new byte[payloadLen];
            if (!ReadExact(stream, payload, (int)payloadLen)) return null;

            // Unmask
            if (isMasked && mask != null)
            {
                for (int i = 0; i < payload.Length; i++)
                    payload[i] ^= mask[i % 4];
            }

            return Encoding.UTF8.GetString(payload);
        }

        private static bool ReadExact(NetworkStream stream, byte[] buffer, int count)
        {
            int offset = 0;
            while (offset < count)
            {
                int read = stream.Read(buffer, offset, count - offset);
                if (read <= 0) return false;
                offset += read;
            }
            return true;
        }
    }

    // ── WebSocket client wrapper ───────────────────────────────────

    internal class WebSocketClient
    {
        private readonly TcpClient _tcp;
        private readonly NetworkStream _stream;
        private volatile bool _connected;

        public bool IsConnected => _connected && _tcp.Connected;
        public NetworkStream Stream => _stream;

        public WebSocketClient(TcpClient tcp)
        {
            _tcp = tcp;
            _stream = tcp.GetStream();
            _connected = true;
        }

        public void Send(byte[] data)
        {
            if (!IsConnected) return;
            _stream.Write(data, 0, data.Length);
            _stream.Flush();
        }

        public void Close()
        {
            _connected = false;
            try { _stream?.Close(); } catch { }
            try { _tcp?.Close(); } catch { }
        }
    }
}
