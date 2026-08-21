import fs from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    // Look for CHANGELOG.md in public or repo root
    const publicPath = path.join(process.cwd(), "public", "CHANGELOG.md");
    const rootPath = path.join(process.cwd(), "CHANGELOG.md");
    
    let content = "";
    try {
      content = await fs.readFile(publicPath, "utf-8");
    } catch {
      content = await fs.readFile(rootPath, "utf-8");
    }

    return new NextResponse(content, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to read changelog" },
      { status: 500 }
    );
  }
}
