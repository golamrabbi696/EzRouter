import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, updateApiKey } from "@/lib/localDb";
import { validateKeyAccessInput } from "@/shared/utils/keyAccess.js";

function parsePolicy(body) {
  const data = {};
  if (body.isActive !== undefined) data.isActive = body.isActive === true;
  if (body.scope !== undefined) data.scope = body.scope;
  if (body.expiresAt !== undefined) {
    if (body.expiresAt && Number.isNaN(new Date(body.expiresAt).getTime())) throw new Error("Expiration must be a valid date");
    data.expiresAt = body.expiresAt || null;
  }
  if (body.tokenLimit !== undefined) {
    const tokenLimit = body.tokenLimit === "" || body.tokenLimit == null ? null : Number(body.tokenLimit);
    if (tokenLimit != null && (!Number.isSafeInteger(tokenLimit) || tokenLimit < 1)) throw new Error("Token limit must be a positive whole number");
    data.tokenLimit = tokenLimit;
  }
  if (body.tokenLimitIncrement !== undefined) {
    const increment = Number(body.tokenLimitIncrement);
    if (!Number.isSafeInteger(increment) || increment < 1) throw new Error("Token addition must be a positive whole number");
    data.tokenLimitIncrement = increment;
  }
  if (body.allowedModels !== undefined) {
    if (!Array.isArray(body.allowedModels)) throw new Error("Allowed models must be an array");
    data.allowedModels = body.allowedModels;
  }
  if (body.access !== undefined) {
    const checked = validateKeyAccessInput(body.access);
    if (!checked.ok) throw new Error(checked.error);
    data.access = checked.value;
  }
  return data;
}

export async function GET(request, { params }) {
  try {
    const key = await getApiKeyById((await params).id);
    if (!key) return NextResponse.json({ error: "Key not found" }, { status: 404 });
    return NextResponse.json({ key });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    if (!await getApiKeyById(id)) return NextResponse.json({ error: "Key not found" }, { status: 404 });
    const updated = await updateApiKey(id, parsePolicy(await request.json()));
    return NextResponse.json({ key: updated });
  } catch (error) {
    const status = /Token limit|Token addition|Cannot add tokens|Expiration|Allowed models|access/i.test(error.message) ? 400 : 500;
    console.log("Error updating key:", error);
    return NextResponse.json({ error: status === 400 ? error.message : "Failed to update key" }, { status });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const success = await deleteApiKey(id);
    if (!success) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}
