// Injected on close to silence a keep-alive WebView. Both embedded WebView
// hosts (the EmbeddedWebView branch and the native static custom-app branch's
// CodeArtifactWebView) stay MOUNTED after close — external apps and vibecoded
// custom apps rely on page state surviving close→reopen — so a playing
// <video>/<audio>, or a YouTube IFrame player, keeps making sound behind the
// faded-out host unless we explicitly pause it. `player` is the YT.Player
// instance exposed by buildYouTubeResourceDocument; the postMessage to any
// iframe is the cross-origin fallback for it. Every step is guarded so this is
// a safe no-op for content that has none of the above.
export const PAUSE_MEDIA_SNIPPET = `
(function () {
  try {
    var media = document.querySelectorAll("video, audio");
    for (var i = 0; i < media.length; i++) {
      try { media[i].pause(); } catch (e) {}
    }
  } catch (e) {}
  try {
    if (typeof player !== "undefined" && player && typeof player.pauseVideo === "function") {
      player.pauseVideo();
    }
  } catch (e) {}
  try {
    var frames = document.querySelectorAll("iframe");
    for (var j = 0; j < frames.length; j++) {
      try {
        if (frames[j].contentWindow) {
          frames[j].contentWindow.postMessage(
            '{"event":"command","func":"pauseVideo","args":""}',
            "*"
          );
        }
      } catch (e) {}
    }
  } catch (e) {}
})();
true;
`;
