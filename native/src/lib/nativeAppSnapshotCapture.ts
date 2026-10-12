export function nativeAppSnapshotInjectionScript(
  requestJson: string,
  timeoutMs: number,
  defaultMaxWidth: number,
): string {
  return String.raw`
    (() => {
      const request = ${requestJson};
      const post = (type, value = {}) =>
        window.ReactNativeWebView?.postMessage(JSON.stringify({
          protocol: request.protocol,
          version: request.version,
          nonce: request.nonce,
          type,
          ...value,
        }));
      const hash = (value) => {
        let result = 0x811c9dc5;
        for (let index = 0; index < value.length; index += 1) {
          result ^= value.charCodeAt(index);
          result = Math.imul(result, 0x01000193);
        }
        return (result >>> 0).toString(16).padStart(8, "0");
      };
      const canvasFallback = (maxWidth, width, height) => {
        const canvases = [...document.querySelectorAll("canvas")];
        if (canvases.length !== 1) return null;
        const canvas = canvases[0];
        if (!canvas.width || !canvas.height) return null;
        if (canvas.width * canvas.height < width * height * 0.6) return null;
        if (canvas.width <= maxWidth) {
          return canvas.toDataURL("image/jpeg", 0.7);
        }
        const scale = maxWidth / canvas.width;
        const output = document.createElement("canvas");
        output.width = maxWidth;
        output.height = Math.ceil(canvas.height * scale);
        const context = output.getContext("2d");
        if (!context) throw new Error("Canvas unavailable");
        context.drawImage(canvas, 0, 0, output.width, output.height);
        return output.toDataURL("image/jpeg", 0.7);
      };
      const compositeCanvases = async (
        backgroundDataUrl,
        canvases,
        width,
        height,
        scale,
      ) => {
        if (canvases.length === 0) return backgroundDataUrl;
        const image = new Image();
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = () => reject(new Error("Render failed"));
          image.src = backgroundDataUrl;
        });
        const output = document.createElement("canvas");
        output.width = Math.ceil(width * scale);
        output.height = Math.ceil(height * scale);
        const context = output.getContext("2d");
        if (!context) throw new Error("Canvas unavailable");
        context.drawImage(image, 0, 0);
        for (const canvas of canvases) {
          const rect = canvas.getBoundingClientRect();
          if (!canvas.width || !canvas.height || !rect.width || !rect.height) {
            continue;
          }
          context.drawImage(
            canvas,
            rect.left * scale,
            rect.top * scale,
            rect.width * scale,
            rect.height * scale,
          );
        }
        return output.toDataURL("image/jpeg", 0.7);
      };
      const capture = async () => {
        const domToImage = window.domtoimage;
        if (!domToImage?.toJpeg) throw new Error("dom-to-image unavailable");
        const root = document.body || document.documentElement;
        const documentElement = document.documentElement;
        const body = document.body;
        const width = Number.isFinite(request.width) && request.width > 0
          ? request.width
          : Math.max(
              innerWidth,
              documentElement.clientWidth,
              body?.clientWidth || 0,
            ) || 800;
        const height = Number.isFinite(request.height) && request.height > 0
          ? request.height
          : Math.max(
              innerHeight,
              documentElement.clientHeight,
              body?.clientHeight || 0,
            ) || 600;
        const maxWidth = Number.isFinite(request.maxWidth)
          ? Math.max(1, Math.min(1600, Math.round(request.maxWidth)))
          : ${defaultMaxWidth};
        const scale = Math.min(1, maxWidth / width);
        const canvases = [...document.querySelectorAll("canvas")];
        try {
          const backgroundDataUrl = await domToImage.toJpeg(root, {
            quality: 0.7,
            bgcolor: "#fff",
            width: Math.ceil(width * scale),
            height: Math.ceil(height * scale),
            filter: (node) =>
              node.tagName !== "CANVAS" && node.tagName !== "SCRIPT",
            style: {
              transform: "scale(" + scale + ")",
              transformOrigin: "top left",
              width: width + "px",
              height: height + "px",
            },
          });
          return await compositeCanvases(
            backgroundDataUrl,
            canvases,
            width,
            height,
            scale,
          );
        } catch (error) {
          const fallback = canvasFallback(maxWidth, width, height);
          if (fallback) return fallback;
          throw error;
        }
      };
      let timer;
      Promise.race([
        capture(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Timeout")), ${timeoutMs});
        }),
      ]).then(
        (dataUrl) => {
          post("rabbithole:snapshot:result", {
            requestId: request.requestId,
            dataUrl,
            hash: hash(dataUrl),
          });
        },
        (error) =>
          post("rabbithole:snapshot:result", {
            requestId: request.requestId,
            error: String(error?.message || error).slice(0, 300),
          }),
      ).finally(() => clearTimeout(timer));
    })();
    true;
  `;
}
