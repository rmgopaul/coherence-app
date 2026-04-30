import express, { type Express, type Response } from "express";
import fs from "fs";
import { type Server } from "http";
import { nanoid } from "nanoid";
import path from "path";
import { createServer as createViteServer } from "vite";
import viteConfig from "../../vite.config";

export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;
    const isSolarRec = url.startsWith("/solar-rec") && !url.startsWith("/solar-rec/api/");

    try {
      const htmlFile = isSolarRec ? "solar-rec.html" : "index.html";
      const scriptSrc = isSolarRec ? `src="/src/solar-rec-main.tsx"` : `src="/src/main.tsx"`;
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "../..",
        "client",
        htmlFile
      );

      // always reload the html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        scriptSrc,
        `${scriptSrc.slice(0, -1)}?v=${nanoid()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

function setStaticCacheHeaders(res: Response, filePath: string): void {
  const fileName = path.basename(filePath);

  if (filePath.includes(`${path.sep}assets${path.sep}`)) {
    res.setHeader(
      "Cache-Control",
      "public, max-age=31536000, immutable"
    );
    return;
  }

  if (
    fileName.endsWith(".html") ||
    fileName === "service-worker.js" ||
    fileName === "manifest.webmanifest"
  ) {
    res.setHeader("Cache-Control", "no-cache");
    return;
  }

  if (/\.(?:png|svg|ico|webp|jpg|jpeg)$/i.test(fileName)) {
    res.setHeader("Cache-Control", "public, max-age=86400");
  }
}

export function serveStatic(app: Express) {
  const distPath =
    process.env.NODE_ENV === "development"
      ? path.resolve(import.meta.dirname, "../..", "dist", "public")
      : path.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }

  app.use(
    "/assets",
    express.static(path.resolve(distPath, "assets"), {
      immutable: true,
      maxAge: "1y",
      setHeaders: setStaticCacheHeaders,
    })
  );
  app.use(
    express.static(distPath, {
      setHeaders: setStaticCacheHeaders,
    })
  );

  // Solar REC standalone route — serve solar-rec.html
  app.use("/solar-rec/*", (_req, res) => {
    const solarRecHtml = path.resolve(distPath, "solar-rec.html");
    res.setHeader("Cache-Control", "no-cache");
    if (fs.existsSync(solarRecHtml)) {
      res.sendFile(solarRecHtml);
    } else {
      res.sendFile(path.resolve(distPath, "index.html"));
    }
  });

  // fall through to index.html if the file doesn't exist
  app.use("*", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
