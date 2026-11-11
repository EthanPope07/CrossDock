// CrossDock win-sender
// Watches a directory with ReadDirectoryChangesW and mirrors it to a remote
// receiver over a raw TCP socket. Native Win32 only (no WSL).
//
// Wire protocol (all integers big-endian), one frame per file-system action:
//   u8  action        1=WRITE 2=DELETE 3=MKDIR 4=PRUNE 5=PING
//   u16 pathLen
//   ... path          UTF-8, relative to the watch root, '/' separators
//   u64 size          payload length
//   ... payload       WRITE: file bytes. PRUNE: '\n'-joined manifest. else empty.
// The receiver answers every frame with one byte: 0x06 (ACK) or 0x15 (NAK).
//
// Reliability: on any socket failure the sender reconnects with exponential
// backoff and performs a full resync (mirror + prune) so nothing is missed.

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <shellapi.h>
#include <timeapi.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <deque>
#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
#include <string>
#include <vector>

namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;

enum : uint8_t { ACT_WRITE = 1, ACT_DELETE = 2, ACT_MKDIR = 3, ACT_PRUNE = 4, ACT_PING = 5 };
static const uint8_t ACK = 0x06;
static const uint64_t MAX_PAYLOAD = 256ull << 20;  // 256 MiB per file
static const int ACK_WINDOW = 256;                 // max un-acked frames in flight
static const double HEARTBEAT_MS = 5000;
static const double MAX_BATCH_AGE_MS = 25;         // never starve a flush

// ---------------------------------------------------------------- utilities
static double nowMs() {
  return std::chrono::duration<double, std::milli>(Clock::now().time_since_epoch()).count();
}

static std::string toUtf8(const std::wstring& w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), s.data(), n, nullptr, nullptr);
  return s;
}

static std::wstring fromUtf8(const std::string& s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), w.data(), n);
  return w;
}

static std::string isoNow() {
  SYSTEMTIME st;
  GetSystemTime(&st);
  char b[40];
  snprintf(b, sizeof b, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", st.wYear, st.wMonth, st.wDay,
           st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
  return b;
}

static std::string jsonEscape(const std::string& s) {
  std::string o;
  for (unsigned char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      default:
        if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
        else o += (char)c;
    }
  }
  return o;
}

static std::wstring envW(const wchar_t* name) {
  const wchar_t* v = _wgetenv(name);
  return v ? v : L"";
}

// ------------------------------------------------------------------ logging
static std::mutex g_logMu;
static FILE* g_logFile = nullptr;
static bool g_verbose = false;

static void logf(const char* lvl, bool debug, const char* fmt, ...) {
  char msg[2048];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(msg, sizeof msg, fmt, ap);
  va_end(ap);
  SYSTEMTIME st;
  GetLocalTime(&st);
  char line[2300];
  snprintf(line, sizeof line, "%04d-%02d-%02d %02d:%02d:%02d.%03d [%s] %s\n", st.wYear, st.wMonth,
           st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds, lvl, msg);
  std::lock_guard<std::mutex> lk(g_logMu);
  if (!debug || g_verbose) { fputs(line, stdout); fflush(stdout); }
  if (g_logFile) { fputs(line, g_logFile); fflush(g_logFile); }
}
#define LOGI(...) logf("INFO", false, __VA_ARGS__)
#define LOGW(...) logf("WARN", false, __VA_ARGS__)
#define LOGE(...) logf("ERROR", false, __VA_ARGS__)
#define LOGD(...) logf("DEBUG", true, __VA_ARGS__)

static void initLog() {
  std::wstring dir = envW(L"CROSSDOCK_LOG_DIR");
  if (dir.empty()) dir = envW(L"USERPROFILE") + L"\\.crossdock\\logs";
  std::error_code ec;
  fs::create_directories(dir, ec);
  std::wstring path = dir + L"\\win-sender.log";
  g_logFile = _wfopen(path.c_str(), L"ab");
  if (!g_logFile) fprintf(stderr, "warning: cannot open log file\n");
}

// -------------------------------------------------------------- exclusions
// Keep in sync with the keep-list in mac-listener/listener.js.
static bool isExcluded(const std::string& rel) {
  static const char* dirs[] = {".git", "node_modules", ".build", "DerivedData", ".crossdock", ".vs", ".idea"};
  size_t start = 0;
  std::string last;
  while (start <= rel.size()) {
    size_t e = rel.find('/', start);
    if (e == std::string::npos) e = rel.size();
    std::string comp = rel.substr(start, e - start);
    for (const char* d : dirs)
      if (comp == d) return true;
    last = comp;
    start = e + 1;
  }
  auto ends = [&](const char* suf) {
    size_t n = strlen(suf);
    return last.size() >= n && last.compare(last.size() - n, n, suf) == 0;
  };
  return ends("~") || ends(".tmp") || ends(".swp") || ends(".swx") || last.rfind(".#", 0) == 0 ||
         last == ".DS_Store" || last == "desktop.ini" || last == "Thumbs.db" || last.find(".crossdock-tmp-") != std::string::npos;
}

// ---------------------------------------------------------------- telemetry
struct SyncEvt { std::string path; double latencyMs; uint64_t bytes; std::string at; };
static std::deque<SyncEvt> g_syncs;  // newest first, max 10
static std::string g_tcp = "down", g_lastErr, g_host, g_port;
static uint64_t g_connects = 0, g_totalFrames = 0;
static std::wstring g_telePath;

static void writeTelemetry() {
  if (g_telePath.empty()) return;
  std::string j = "{\n  \"module\": \"win-sender\",\n  \"updated\": \"" + isoNow() + "\",\n";
  j += "  \"connection\": {\"tcp\": \"" + g_tcp + "\", \"host\": \"" + jsonEscape(g_host) +
       "\", \"port\": " + (g_port.empty() ? "0" : g_port) + ", \"connects\": " + std::to_string(g_connects) +
       ", \"totalFrames\": " + std::to_string(g_totalFrames) + ", \"lastError\": \"" + jsonEscape(g_lastErr) + "\"},\n";
  j += "  \"syncs\": [";
  bool first = true;
  for (auto& s : g_syncs) {
    char lat[32];
    snprintf(lat, sizeof lat, "%.2f", s.latencyMs);
    j += std::string(first ? "\n    " : ",\n    ") + "{\"path\": \"" + jsonEscape(s.path) + "\", \"latencyMs\": " + lat +
         ", \"bytes\": " + std::to_string(s.bytes) + ", \"at\": \"" + s.at + "\"}";
    first = false;
  }
  j += first ? "]\n}\n" : "\n  ]\n}\n";
  std::error_code ec;
  fs::create_directories(fs::path(g_telePath).parent_path(), ec);
  std::wstring tmp = g_telePath + L".tmp";
  {
    std::ofstream f(tmp.c_str(), std::ios::binary | std::ios::trunc);
    if (!f) { LOGD("telemetry: cannot write %s", toUtf8(tmp).c_str()); return; }
    f << j;
  }
  if (!MoveFileExW(tmp.c_str(), g_telePath.c_str(), MOVEFILE_REPLACE_EXISTING))
    LOGD("telemetry: replace failed (%lu)", GetLastError());
}

static void recordSync(const std::string& path, double latency, uint64_t bytes) {
  g_syncs.push_front({path, latency, bytes, isoNow()});
  while (g_syncs.size() > 10) g_syncs.pop_back();
}

// ------------------------------------------------------------------ network
struct Conn {
  SOCKET s = INVALID_SOCKET;
  int pending = 0;
  double lastSend = 0;
};

static bool sendAll(SOCKET s, const char* p, size_t n) {
  while (n) {
    int k = send(s, p, (int)std::min<size_t>(n, 1 << 20), 0);
    if (k <= 0) { LOGD("send failed (%d)", WSAGetLastError()); return false; }
    p += k;
    n -= (size_t)k;
  }
  return true;
}

static bool recvAll(SOCKET s, char* p, size_t n) {
  while (n) {
    int k = recv(s, p, (int)n, 0);
    if (k <= 0) { LOGD("recv failed (%d, rc=%d)", WSAGetLastError(), k); return false; }
    p += k;
    n -= (size_t)k;
  }
  return true;
}

static void putBE(std::string& o, uint64_t v, int bytes) {
  for (int i = bytes - 1; i >= 0; --i) o.push_back((char)((v >> (8 * i)) & 0xFF));
}

static bool drainAcks(Conn& c) {
  while (c.pending > 0) {
    uint8_t b;
    if (!recvAll(c.s, (char*)&b, 1)) return false;
    if (b != ACK) LOGW("receiver NAK'd a frame (0x%02x)", b);
    c.pending--;
  }
  return true;
}

static bool sendFrame(Conn& c, uint8_t act, const std::string& path, const char* payload, uint64_t size) {
  if (path.size() > 0xFFFF) { LOGW("path too long, skipping: %.80s...", path.c_str()); return true; }
  std::string h;
  h.push_back((char)act);
  putBE(h, path.size(), 2);
  h += path;
  putBE(h, size, 8);
  bool ok;
  if (size <= 65536) {
    if (size) h.append(payload, (size_t)size);
    ok = sendAll(c.s, h.data(), h.size());
  } else {
    ok = sendAll(c.s, h.data(), h.size()) && sendAll(c.s, payload, (size_t)size);
  }
  if (!ok) return false;
  c.pending++;
  g_totalFrames++;
  c.lastSend = nowMs();
  LOGD("sent action=%u path=%s size=%llu", act, path.c_str(), (unsigned long long)size);
  return c.pending >= ACK_WINDOW ? drainAcks(c) : true;
}

static SOCKET connectOnce(const std::string& host, const std::string& port, std::string& err) {
  addrinfo hints{};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  addrinfo* res = nullptr;
  int rc = getaddrinfo(host.c_str(), port.c_str(), &hints, &res);
  if (rc) { err = "getaddrinfo failed (" + std::to_string(rc) + ")"; return INVALID_SOCKET; }
  SOCKET s = INVALID_SOCKET;
  for (addrinfo* ai = res; ai && s == INVALID_SOCKET; ai = ai->ai_next) {
    SOCKET t = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
    if (t == INVALID_SOCKET) continue;
    u_long nb = 1;
    ioctlsocket(t, FIONBIO, &nb);
    bool ok = connect(t, ai->ai_addr, (int)ai->ai_addrlen) == 0;
    if (!ok && WSAGetLastError() == WSAEWOULDBLOCK) {
      fd_set wf, ef;
      FD_ZERO(&wf); FD_ZERO(&ef);
      FD_SET(t, &wf); FD_SET(t, &ef);
      timeval tv{3, 0};
      if (select(0, nullptr, &wf, &ef, &tv) > 0) {
        int soerr = 0, len = sizeof soerr;
        getsockopt(t, SOL_SOCKET, SO_ERROR, (char*)&soerr, &len);
        ok = FD_ISSET(t, &wf) && soerr == 0;
        if (!ok) err = "connect failed (WSA " + std::to_string(soerr ? soerr : WSAECONNREFUSED) + ")";
      } else {
        err = "connect timed out";
      }
    } else if (!ok) {
      err = "connect failed (WSA " + std::to_string(WSAGetLastError()) + ")";
    }
    if (ok) { nb = 0; ioctlsocket(t, FIONBIO, &nb); s = t; } else closesocket(t);
  }
  freeaddrinfo(res);
  if (s != INVALID_SOCKET) {
    BOOL one = TRUE;
    setsockopt(s, IPPROTO_TCP, TCP_NODELAY, (const char*)&one, sizeof one);
    setsockopt(s, SOL_SOCKET, SO_KEEPALIVE, (const char*)&one, sizeof one);
    DWORD rt = 10000, st = 10000;
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char*)&rt, sizeof rt);
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, (const char*)&st, sizeof st);
  }
  return s;
}

// -------------------------------------------------------------- file access
// Returns 0 on success or a Win32 error code. Opens with full sharing and
// retries briefly, because editors/AV often hold a file right after a save.
static DWORD readFileShared(const fs::path& p, std::vector<char>& out) {
  HANDLE h = INVALID_HANDLE_VALUE;
  DWORD err = 0;
  for (int i = 0; i < 50; ++i) {
    h = CreateFileW(p.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                    OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h != INVALID_HANDLE_VALUE) break;
    err = GetLastError();
    LOGD("open retry %d for %s: Win32 error %lu", i, toUtf8(p.filename().wstring()).c_str(), err);
    if (err != ERROR_SHARING_VIOLATION && err != ERROR_ACCESS_DENIED && err != ERROR_LOCK_VIOLATION) return err;
    Sleep(2);
  }
  if (h == INVALID_HANDLE_VALUE) return err;
  LARGE_INTEGER sz;
  if (!GetFileSizeEx(h, &sz)) { err = GetLastError(); CloseHandle(h); return err; }
  if ((uint64_t)sz.QuadPart > MAX_PAYLOAD) { CloseHandle(h); return ERROR_FILE_TOO_LARGE; }
  out.resize((size_t)sz.QuadPart);
  size_t got = 0;
  while (got < out.size()) {
    DWORD n = 0;
    if (!ReadFile(h, out.data() + got, (DWORD)std::min<size_t>(out.size() - got, 1u << 24), &n, nullptr) || n == 0) break;
    got += n;
  }
  CloseHandle(h);
  out.resize(got);  // file may have shrunk while reading; a later event resends
  return 0;
}

enum SendResult { SR_OK, SR_SKIP, SR_FAIL };

static SendResult sendFileFrame(Conn& c, const std::string& rel, const fs::path& full, uint64_t& bytes) {
  std::vector<char> buf;
  double tr = nowMs();
  DWORD err = readFileShared(full, buf);
  LOGD("read %s took %.2f ms (err=%lu)", rel.c_str(), nowMs() - tr, err);
  if (err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND) return SR_SKIP;  // deleted meanwhile
  if (err) { LOGW("cannot read %s (Win32 error %lu); skipping", rel.c_str(), err); return SR_SKIP; }
  bytes = buf.size();
  return sendFrame(c, ACT_WRITE, rel, buf.data(), buf.size()) ? SR_OK : SR_FAIL;
}

struct Config {
  fs::path root;
  std::string host = "127.0.0.1", port = "9477";
  // One save yields 2+ events within ~1 ms; 1 ms merges them. Latency is
  // debounce + ~10 ms fixed Windows file-open cost, so keep this small.
  int debounceMs = 1;
};
static Config g_cfg;

static std::string relOf(const fs::path& full) {
  return toUtf8(full.lexically_relative(g_cfg.root).generic_wstring());
}

// Sends the tree under `dir` (dir itself is the caller's job). Fills manifest if given.
static bool sendTree(Conn& c, const fs::path& dir, std::vector<std::string>* manifest, bool& scanOk, size_t& files) {
  std::error_code ec;
  fs::recursive_directory_iterator it(dir, fs::directory_options::skip_permission_denied, ec), end;
  if (ec) { scanOk = false; LOGW("scan of %s failed: %s", toUtf8(dir.wstring()).c_str(), ec.message().c_str()); return true; }
  for (; it != end; it.increment(ec)) {
    if (ec) { scanOk = false; LOGW("scan error: %s", ec.message().c_str()); ec.clear(); continue; }
    std::string rel = relOf(it->path());
    if (isExcluded(rel)) { if (it->is_directory(ec)) it.disable_recursion_pending(); continue; }
    if (it->is_directory(ec)) {
      if (!sendFrame(c, ACT_MKDIR, rel, nullptr, 0)) return false;
      if (manifest) manifest->push_back(rel);
    } else if (it->is_regular_file(ec)) {
      uint64_t bytes = 0;
      SendResult r = sendFileFrame(c, rel, it->path(), bytes);
      if (r == SR_FAIL) return false;
      if (r == SR_OK) { files++; if (manifest) manifest->push_back(rel); }
      else scanOk = false;  // unreadable file: don't let prune delete its remote copy
    }
  }
  return true;
}

static bool fullSync(Conn& c) {
  double t0 = nowMs();
  std::vector<std::string> manifest;
  bool scanOk = true;
  size_t files = 0;
  if (!sendTree(c, g_cfg.root, &manifest, scanOk, files)) return false;
  if (scanOk) {
    std::string m;
    for (size_t i = 0; i < manifest.size(); ++i) { if (i) m += '\n'; m += manifest[i]; }
    if (!sendFrame(c, ACT_PRUNE, "", m.data(), m.size())) return false;
  } else {
    LOGW("scan was incomplete; skipping PRUNE so the remote copy is not damaged");
  }
  if (!drainAcks(c)) return false;
  LOGI("initial sync complete: %zu files, %zu entries in %.1f ms", files, manifest.size(), nowMs() - t0);
  return true;
}

// ----------------------------------------------------------------- watching
struct Pend { bool removed = false, added = false; double t0 = 0; };

static const DWORD NOTIFY_FILTER = FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME |
                                   FILE_NOTIFY_CHANGE_SIZE | FILE_NOTIFY_CHANGE_LAST_WRITE | FILE_NOTIFY_CHANGE_CREATION;

struct Watcher {
  HANDLE dir = INVALID_HANDLE_VALUE, ev = nullptr;
  OVERLAPPED ov{};
  std::vector<char> buf = std::vector<char>(256 * 1024);
  std::map<std::string, Pend> pending;
  double firstEvent = 0, lastEvent = 0;
  bool needResync = false;

  bool open(const fs::path& root) {
    dir = CreateFileW(root.c_str(), FILE_LIST_DIRECTORY, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                      OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED, nullptr);
    if (dir == INVALID_HANDLE_VALUE) { LOGE("cannot open directory (Win32 error %lu)", GetLastError()); return false; }
    ev = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    return issue();
  }

  bool issue() {
    ResetEvent(ev);
    ov = OVERLAPPED{};
    ov.hEvent = ev;
    if (!ReadDirectoryChangesW(dir, buf.data(), (DWORD)buf.size(), TRUE, NOTIFY_FILTER, nullptr, &ov, nullptr)) {
      LOGE("ReadDirectoryChangesW failed (Win32 error %lu)", GetLastError());
      return false;
    }
    return true;
  }

  // Called when `ev` is signalled. Returns false if the watch is dead.
  bool collect() {
    DWORD bytes = 0;
    if (!GetOverlappedResult(dir, &ov, &bytes, FALSE)) {
      LOGE("directory watch failed (Win32 error %lu)", GetLastError());
      return false;
    }
    double t = nowMs();
    if (bytes == 0) {
      LOGW("change buffer overflowed; scheduling full resync");
      needResync = true;
    } else {
      char* p = buf.data();
      for (;;) {
        auto* fni = (FILE_NOTIFY_INFORMATION*)p;
        std::string rel = toUtf8(std::wstring(fni->FileName, fni->FileNameLength / sizeof(WCHAR)));
        std::replace(rel.begin(), rel.end(), '\\', '/');
        if (!isExcluded(rel)) {
          Pend& pe = pending[rel];
          if (pe.t0 == 0) pe.t0 = t;
          switch (fni->Action) {
            case FILE_ACTION_ADDED: case FILE_ACTION_RENAMED_NEW_NAME: pe.removed = false; pe.added = true; break;
            case FILE_ACTION_MODIFIED: pe.removed = false; break;
            case FILE_ACTION_REMOVED: case FILE_ACTION_RENAMED_OLD_NAME: pe.removed = true; pe.added = false; break;
          }
          LOGD("event action=%lu path=%s", fni->Action, rel.c_str());
        }
        if (!fni->NextEntryOffset) break;
        p += fni->NextEntryOffset;
      }
      if (!pending.empty()) {
        if (firstEvent == 0) firstEvent = t;
        lastEvent = t;
      }
    }
    return issue();
  }

  void clear() { pending.clear(); firstEvent = lastEvent = 0; }
};

struct Item { std::string rel; double t0; uint64_t bytes; };

static bool flush(Conn& c, Watcher& w) {
  LOGD("flush begin");
  std::vector<Item> items;
  std::map<std::string, Pend> batch;
  batch.swap(w.pending);
  w.firstEvent = w.lastEvent = 0;
  for (auto& [rel, pe] : batch) {  // sorted: parents before children
    fs::path full = g_cfg.root / fromUtf8(rel);
    DWORD attrs = GetFileAttributesW(full.c_str());
    bool exists = attrs != INVALID_FILE_ATTRIBUTES;
    if (pe.removed && !exists) {
      if (!sendFrame(c, ACT_DELETE, rel, nullptr, 0)) return false;
      items.push_back({rel, pe.t0, 0});
    } else if (!exists) {
      continue;  // transient file that vanished; a REMOVED event covers it
    } else if (attrs & FILE_ATTRIBUTE_DIRECTORY) {
      if (!pe.added) continue;  // directory timestamp change only
      if (!sendFrame(c, ACT_MKDIR, rel, nullptr, 0)) return false;
      bool scanOk = true;
      size_t files = 0;
      if (!sendTree(c, full, nullptr, scanOk, files)) return false;
      items.push_back({rel + "/", pe.t0, 0});
    } else {
      uint64_t bytes = 0;
      SendResult r = sendFileFrame(c, rel, full, bytes);
      if (r == SR_FAIL) return false;
      if (r == SR_OK) items.push_back({rel, pe.t0, bytes});
    }
  }
  if (!drainAcks(c)) return false;
  double done = nowMs();
  for (auto& it : items) {
    recordSync(it.rel, done - it.t0, it.bytes);
    LOGD("synced %s (%llu bytes) latency=%.2f ms", it.rel.c_str(), (unsigned long long)it.bytes, done - it.t0);
  }
  if (!items.empty()) {
    LOGI("flushed %zu item(s), last latency %.2f ms", items.size(), done - items.back().t0);
    writeTelemetry();
  }
  return true;
}

// --------------------------------------------------------------------- main
static std::atomic<bool> g_stop{false};
static BOOL WINAPI onCtrl(DWORD) { g_stop = true; return TRUE; }

static void sleepInterruptible(double ms) {
  double end = nowMs() + ms;
  while (!g_stop && nowMs() < end) Sleep(50);
}

static void usage() {
  printf("win-sender --dir <path> [--host 127.0.0.1] [--port 9477] [--telemetry <file>] [--debounce-ms 1] [--verbose]\n");
}

int main() {
  int argc = 0;
  LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  std::wstring dir, tele = L".crossdock\\crossdock-telemetry.sync.json";
  for (int i = 1; i < argc; ++i) {
    std::wstring a = argv[i];
    auto next = [&]() -> std::wstring { return i + 1 < argc ? argv[++i] : L""; };
    if (a == L"--dir") dir = next();
    else if (a == L"--host") g_cfg.host = toUtf8(next());
    else if (a == L"--port") g_cfg.port = toUtf8(next());
    else if (a == L"--telemetry") tele = next();
    else if (a == L"--debounce-ms") g_cfg.debounceMs = _wtoi(next().c_str());
    else if (a == L"--verbose") g_verbose = true;
    else { usage(); return a == L"--help" ? 0 : 2; }
  }
  if (dir.empty()) { usage(); return 2; }
  initLog();
  std::error_code ec;
  g_cfg.root = fs::absolute(fs::path(dir), ec).lexically_normal();
  while (!g_cfg.root.empty() && (g_cfg.root.native().back() == L'\\' || g_cfg.root.native().back() == L'/'))
    g_cfg.root = fs::path(g_cfg.root.native().substr(0, g_cfg.root.native().size() - 1));
  if (!fs::is_directory(g_cfg.root, ec)) { LOGE("watch directory does not exist: %s", toUtf8(g_cfg.root.wstring()).c_str()); return 1; }
  g_telePath = fs::absolute(fs::path(tele), ec).wstring();
  g_host = g_cfg.host;
  g_port = g_cfg.port;

  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2, 2), &wsa)) { LOGE("WSAStartup failed"); return 1; }
  SetConsoleCtrlHandler(onCtrl, TRUE);
  // Default Windows timer tick is ~15.6 ms, which would round our short
  // debounce wait up to 15-30 ms. Ask for 1 ms granularity.
  timeBeginPeriod(1);
  LOGI("win-sender starting: watching %s -> %s:%s (debounce %d ms)", toUtf8(g_cfg.root.wstring()).c_str(), g_cfg.host.c_str(),
       g_cfg.port.c_str(), g_cfg.debounceMs);

  Watcher w;
  if (!w.open(g_cfg.root)) return 1;
  writeTelemetry();

  double backoff = 250;
  while (!g_stop) {
    std::string err;
    Conn c;
    c.s = connectOnce(g_cfg.host, g_cfg.port, err);
    if (c.s == INVALID_SOCKET) {
      g_tcp = "down";
      g_lastErr = err;
      writeTelemetry();
      LOGW("%s; retrying in %.0f ms", err.c_str(), backoff);
      sleepInterruptible(backoff);
      backoff = std::min(backoff * 2, 5000.0);
      continue;
    }
    backoff = 250;
    g_connects++;
    g_tcp = "up";
    g_lastErr.clear();
    LOGI("connected to %s:%s", g_cfg.host.c_str(), g_cfg.port.c_str());
    w.clear();
    w.needResync = false;
    c.lastSend = nowMs();
    bool ok = fullSync(c);
    writeTelemetry();

    while (ok && !g_stop) {
      double now = nowMs();
      DWORD timeout;
      if (!w.pending.empty()) {
        double due = std::min(w.lastEvent + g_cfg.debounceMs, w.firstEvent + MAX_BATCH_AGE_MS);
        timeout = due <= now ? 0 : (DWORD)std::ceil(due - now);
      } else {
        double rem = c.lastSend + HEARTBEAT_MS - now;
        timeout = rem <= 0 ? 0 : (DWORD)std::min(rem, 1000.0);
      }
      if (WaitForSingleObject(w.ev, timeout) == WAIT_OBJECT_0) {
        if (!w.collect()) { g_stop = true; break; }
        continue;  // re-evaluate debounce with the new event
      }
      if (w.needResync) {
        w.needResync = false;
        w.clear();
        ok = fullSync(c);
      } else if (!w.pending.empty()) {
        ok = flush(c, w);
      } else if (nowMs() - c.lastSend >= HEARTBEAT_MS) {
        ok = sendFrame(c, ACT_PING, "", nullptr, 0) && drainAcks(c);
        // Refresh the telemetry timestamp so a dashboard can tell "idle but alive" from "crashed".
        if (ok) writeTelemetry();
      }
    }
    closesocket(c.s);
    if (!g_stop) {
      g_tcp = "down";
      g_lastErr = "connection lost";
      writeTelemetry();
      LOGW("connection lost; reconnecting");
    }
  }
  g_tcp = "down";
  writeTelemetry();
  LOGI("win-sender stopped");
  timeEndPeriod(1);
  WSACleanup();
  return 0;
}
