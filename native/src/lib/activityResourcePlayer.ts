const YOUTUBE_ESCAPE_PATH =
  /^\/(watch|channel|user|results|playlist|shorts|feed|account|@|embed\/videoseries)/i;

export const YOUTUBE_RESOURCE_BASE_URL = "https://www.youtube-nocookie.com";

export const YOUTUBE_RESOURCE_ALLOWED_HOSTS = [
  "youtube-nocookie.com",
  "youtube.com",
  "ytimg.com",
  "ggpht.com",
  "googlevideo.com",
  "gstatic.com",
  "googleapis.com",
] as const;

export function isAllowedYouTubeResourceUrl(url: string): boolean {
  if (
    url.startsWith("about:") ||
    url.startsWith("data:") ||
    url.startsWith("blob:")
  ) {
    return true;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  const allowed = YOUTUBE_RESOURCE_ALLOWED_HOSTS.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
  if (!allowed) return false;

  const isYouTube =
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtube-nocookie.com" ||
    host.endsWith(".youtube-nocookie.com");
  return !isYouTube || !YOUTUBE_ESCAPE_PATH.test(parsed.pathname);
}

export function buildYouTubeResourceDocument(embedUrl: string): string {
  const separator = embedUrl.includes("?") ? "&" : "?";
  const playerUrl =
    `${embedUrl}${separator}enablejsapi=1` +
    `&origin=${encodeURIComponent(YOUTUBE_RESOURCE_BASE_URL)}`;
  const playerUrlJson = JSON.stringify(playerUrl).replaceAll("<", "\\u003c");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<style>
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #202020; color: #fff; font-family: system-ui, sans-serif; }
  #player { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
  #status { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; flex-direction: column; gap: 12px; padding: 24px; text-align: center; background: #202020; }
  #status button { border: 1px solid #fff; border-radius: 999px; padding: 10px 18px; color: #fff; background: transparent; font: inherit; }
</style>
</head>
<body>
<iframe id="player" src=${playerUrlJson} frameborder="0"
  allow="encrypted-media; fullscreen" allowfullscreen></iframe>
<div id="status">
  <strong id="status-title">Video complete</strong>
  <span id="status-body"></span>
  <button id="replay" type="button">Watch again</button>
</div>
<script>
  var player = null;
  var watchdog = null;
  var finished = false;
  var frame = document.getElementById('player');
  var status = document.getElementById('status');
  var statusTitle = document.getElementById('status-title');
  var statusBody = document.getElementById('status-body');
  var replay = document.getElementById('replay');
  var startupTimer = setTimeout(function () {
    showStatus('Video unavailable', 'The player could not reach YouTube.', false);
  }, 9000);

  function showStatus(title, body, canReplay) {
    finished = true;
    clearTimeout(startupTimer);
    if (watchdog) clearInterval(watchdog);
    frame.style.visibility = 'hidden';
    statusTitle.textContent = title;
    statusBody.textContent = body || '';
    replay.style.display = canReplay ? 'block' : 'none';
    status.style.display = 'flex';
  }

  replay.addEventListener('click', function () {
    if (!player) return;
    finished = false;
    status.style.display = 'none';
    frame.style.visibility = 'visible';
    player.seekTo(0, true);
    player.playVideo();
    startWatchdog();
  });

  function startWatchdog() {
    if (watchdog) clearInterval(watchdog);
    watchdog = setInterval(function () {
      if (!player || finished) return;
      try {
        var duration = player.getDuration();
        var current = player.getCurrentTime();
        if (duration > 0 && current >= duration - 0.1) {
          showStatus('Video complete', '', true);
        }
      } catch (e) {}
    }, 100);
  }

  window.onYouTubeIframeAPIReady = function () {
    try {
      player = new YT.Player('player', {
        events: {
          onReady: function () {
            clearTimeout(startupTimer);
            startWatchdog();
          },
          onStateChange: function (event) {
            if (event && event.data === 0) showStatus('Video complete', '', true);
          },
          onError: function (event) {
            clearTimeout(startupTimer);
            var code = event && event.data;
            var message = code === 101 || code === 150
              ? "The owner turned off embedding for this video."
              : "This video could not be played here.";
            showStatus('Video unavailable', message, false);
          }
        }
      });
    } catch (e) {
      showStatus('Video unavailable', 'This video could not be played here.', false);
    }
  };

  var api = document.createElement('script');
  api.src = 'https://www.youtube.com/iframe_api';
  api.onerror = function () {
    showStatus('Video unavailable', 'The player could not reach YouTube.', false);
  };
  document.head.appendChild(api);
</script>
</body>
</html>`;
}
