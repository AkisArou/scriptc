import type { MetadataRoute } from "next";
import { allDocsPages } from "@/lib/docs-navigation";
import { siteUrl } from "@/lib/site";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

export default function sitemap(): MetadataRoute.Sitemap {
  const hrefs = ["/", "/status", ...allDocsPages.map((page) => page.href)];
  return hrefs.map((href) => ({
    url: `${siteUrl}${href}`,
    lastModified: lastModifiedFor(href),
  }));
}

function lastModifiedFor(href: string): Date {
  const routeDirectory = path.join(process.cwd(), "src", "app", href.slice(1));
  for (const filename of ["page.tsx", "page.mdx"]) {
    const pagePath = path.join(routeDirectory, filename);
    if (existsSync(pagePath)) {
      return statSync(pagePath).mtime;
    }
  }
  return new Date("2026-07-22T00:00:00.000Z");
}
