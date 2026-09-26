"use client";

import { useState, useEffect } from "react";
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { Card, Button, Modal, Input, CardSkeleton, ModelSelectModal, ConfirmModal, CapacityBadges, Select, Toggle, ComboTestModal } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider, MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
import { aggregateComboCapabilities } from "open-sse/providers/capabilities.js";

// Validate combo name: only a-z, A-Z, 0-9, -, _
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

// Capacity adapter: global fallback pools of models per input-modality capability.
// A request needing a capability the target model/combo lacks switches straight
// to the first enabled model here instead of erroring or dropping the data.
const CAPACITY_ADAPTER_CAPS = [
  { key: "vision", label: "Vision", icon: "visibility", desc: "images (png, jpg, webp, …)" },
  // pdf, videoInput temporarily hidden — no translator support yet for those blocks.
  { key: "audioInput", label: "Audio", icon: "graphic_eq", desc: "audio input" },
];
const DEFAULT_FALLBACK_MODEL = "oc/mimo-v2.6-flash-free";
const EMPTY_CAP_ENTRY = { enabled: true, roundRobin: false, models: [] };
const EMPTY_CAPACITY_ADAPTER = {
  vision: { ...EMPTY_CAP_ENTRY },
  pdf: { ...EMPTY_CAP_ENTRY },
  audioInput: { ...EMPTY_CAP_ENTRY },
  videoInput: { ...EMPTY_CAP_ENTRY },
};
const upgradeLegacyModel = (m) => (m === "oc/mimo-v2.5-free" ? DEFAULT_FALLBACK_MODEL : m);

// Backward-compat: legacy stored form was an array of {model, enabled}.
function normalizeCapEntry(entry) {
  if (Array.isArray(entry)) {
    return { enabled: true, roundRobin: false, models: entry.map((e) => upgradeLegacyModel(e?.model || e)).filter(Boolean) };
  }
  if (entry && typeof entry === "object") {
    return {
      enabled: entry.enabled !== false,
      roundRobin: !!entry.roundRobin,
      models: Array.isArray(entry.models) ? entry.models.map(upgradeLegacyModel).filter(Boolean) : [],
    };
  }
  return { ...EMPTY_CAP_ENTRY };
}

const STRATEGY_OPTIONS = [
  { value: "fallback", label: "Fallback — try in order" },
  { value: "round-robin", label: "Round Robin — rotate" },
  { value: "weighted", label: "Weighted — random by weight" },
  { value: "fusion", label: "Fusion — panel + judge" },
];

export default function CombosPage() {
  const [combos, setCombos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingCombo, setEditingCombo] = useState(null);
  const [testingCombo, setTestingCombo] = useState(null);
  const [activeProviders, setActiveProviders] = useState([]);
  const [comboStrategies, setComboStrategies] = useState({});
  const [capacityAdapter, setCapacityAdapter] = useState(EMPTY_CAPACITY_ADAPTER);
  const { getCaps } = useModelCaps();
  const [confirmState, setConfirmState] = useState(null);
  const [presetLoading, setPresetLoading] = useState(null); // "cursor" | "claude" | null
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const { copied, copy } = useCopyToClipboard();

  useEffect(() => {
    fetchData();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Drop stale selection when the combo list changes (delete / refresh).
  useEffect(() => {
    const alive = new Set(combos.map((c) => c.id));
    setSelectedIds((prev) => prev.filter((id) => alive.has(id)));
  }, [combos]);

  const selectedCombos = combos.filter((c) => selectedIds.includes(c.id));
  const allSelected = combos.length > 0 && selectedIds.length === combos.length;
  const someSelected = selectedIds.length > 0;

  const toggleSelect = (id) => {
    setSelectedIds((prev) => (
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    ));
  };

  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? [] : combos.map((c) => c.id));
  };

  const clearSelection = () => setSelectedIds([]);

  const handleGeneratePresets = async (source) => {
    const label = source === "cursor" ? "Cursor Default" : "Claude Default";
    setPresetLoading(source);
    try {
      const previewRes = await fetch(`/api/combos/presets?source=${source}`);
      const preview = await previewRes.json();
      if (!previewRes.ok) {
        alert(preview.error || `Failed to preview ${label}`);
        return;
      }

      const toCreate = preview.toCreate ?? (preview.items || []).filter((i) => !i.exists).length;
      const toSkip = preview.toSkip ?? (preview.items || []).filter((i) => i.exists).length;
      const total = (preview.items || []).length;

      if (total === 0) {
        alert(`No ${label} models available to generate.`);
        return;
      }

      if (toCreate === 0) {
        alert(`All ${total} ${label} combos already exist. Nothing to create.`);
        return;
      }

      setConfirmState({
        title: `Generate ${label}`,
        message: `Create ${toCreate} combo${toCreate === 1 ? "" : "s"} named like ${source === "cursor" ? "Cursor" : "Claude"} model IDs (seeded with cu/… or cc/…). ${toSkip} already exist and will be skipped. You can edit any combo afterward to add fallbacks.`,
        confirmText: "Generate",
        variant: "primary",
        onConfirm: async () => {
          setConfirmState((prev) => prev ? { ...prev, loading: true } : null);
          try {
            const res = await fetch("/api/combos/presets", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ source }),
            });
            const data = await res.json();
            if (!res.ok) {
              alert(data.error || `Failed to generate ${label}`);
              return;
            }
            await fetchData();
            setConfirmState(null);
          } catch (error) {
            console.log(`Error generating ${label}:`, error);
            alert(`Failed to generate ${label}`);
            setConfirmState((prev) => prev ? { ...prev, loading: false } : null);
          }
        },
      });
    } catch (error) {
      console.log(`Error previewing ${label}:`, error);
      alert(`Failed to preview ${label}`);
    } finally {
      setPresetLoading(null);
    }
  };

  const fetchData = async () => {
    try {
      const [combosRes, providersRes, settingsRes] = await Promise.all([
        fetch("/api/combos"),
        fetch("/api/providers"),
        fetch("/api/settings"),
      ]);
      const combosData = await combosRes.json();
      const providersData = await providersRes.json();
      const settingsData = settingsRes.ok ? await settingsRes.json() : {};

      // Only LLM combos here - webSearch/webFetch combos belong to media-providers/web
      if (combosRes.ok) setCombos((combosData.combos || []).filter(c => !MEDIA_PROVIDER_KINDS.some(({ id }) => id === c.kind)));
      if (providersRes.ok) {
        setActiveProviders(providersData.connections || []);
      }
      setComboStrategies(settingsData.comboStrategies || {});
      const rawAdapter = settingsData.capacityAdapter || {};
      const normalized = {};
      for (const cap of CAPACITY_ADAPTER_CAPS) {
        normalized[cap.key] = normalizeCapEntry(rawAdapter[cap.key]);
      }
      setCapacityAdapter(normalized);
    } catch (error) {
      console.log("Error fetching data:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleSetCapacityAdapter = async (next) => {
    setCapacityAdapter(next);
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capacityAdapter: next }),
      });
    } catch (error) {
      console.log("Error updating capacity adapter:", error);
    }
  };

  const handleCreate = async (data) => {
    try {
      const res = await fetch("/api/combos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        await fetchData();
        setShowCreateModal(false);
      } else {
        const err = await res.json();
        alert(err.error || "Failed to create combo");
      }
    } catch (error) {
      console.log("Error creating combo:", error);
    }
  };

  const handleUpdate = async (id, data) => {
    try {
      const res = await fetch(`/api/combos/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        await fetchData();
        setEditingCombo(null);
      } else {
        const err = await res.json();
        alert(err.error || "Failed to update combo");
      }
    } catch (error) {
      console.log("Error updating combo:", error);
    }
  };

  const pruneStrategiesForNames = (names, base = comboStrategies) => {
    const updated = { ...base };
    for (const name of names) delete updated[name];
    return updated;
  };

  const persistComboStrategies = async (updated) => {
    await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comboStrategies: updated }),
    });
    setComboStrategies(updated);
  };

  const handleDelete = async (id) => {
    const combo = combos.find((c) => c.id === id);
    setConfirmState({
      title: "Delete Combo",
      message: combo ? `Delete combo "${combo.name}"?` : "Delete this combo?",
      onConfirm: async () => {
        setConfirmState((prev) => prev ? { ...prev, loading: true } : null);
        try {
          const res = await fetch(`/api/combos/${id}`, { method: "DELETE" });
          if (res.ok) {
            if (combo?.name) {
              await persistComboStrategies(pruneStrategiesForNames([combo.name]));
            }
            setCombos((prev) => prev.filter((c) => c.id !== id));
            setSelectedIds((prev) => prev.filter((x) => x !== id));
          }
          setConfirmState(null);
        } catch (error) {
          console.log("Error deleting combo:", error);
          setConfirmState((prev) => prev ? { ...prev, loading: false } : null);
        }
      }
    });
  };

  const handleBulkDelete = () => {
    if (selectedCombos.length === 0) return;
    const count = selectedCombos.length;
    setConfirmState({
      title: "Delete Selected Combos",
      message: `Delete ${count} selected combo${count === 1 ? "" : "s"}? This cannot be undone.`,
      confirmText: "Delete",
      variant: "danger",
      onConfirm: async () => {
        setConfirmState((prev) => prev ? { ...prev, loading: true } : null);
        setBulkBusy(true);
        try {
          const ids = selectedCombos.map((c) => c.id);
          const names = selectedCombos.map((c) => c.name);
          const results = await Promise.all(
            ids.map((id) => fetch(`/api/combos/${id}`, { method: "DELETE" }))
          );
          const failed = results.filter((r) => !r.ok).length;
          await persistComboStrategies(pruneStrategiesForNames(names));
          setCombos((prev) => prev.filter((c) => !ids.includes(c.id)));
          clearSelection();
          setConfirmState(null);
          if (failed > 0) alert(`Deleted with ${failed} failure${failed === 1 ? "" : "s"}.`);
        } catch (error) {
          console.log("Error bulk deleting combos:", error);
          alert("Failed to delete selected combos");
          setConfirmState((prev) => prev ? { ...prev, loading: false } : null);
        } finally {
          setBulkBusy(false);
        }
      },
    });
  };

  // Merge a per-combo strategy patch into settings.comboStrategies. Passing an empty
  // patch (strategy back to default "fallback") drops the entry entirely.
  const handleSetComboStrategy = async (comboName, patch) => {
    try {
      const updated = { ...comboStrategies };
      const next = { ...(updated[comboName] || {}), ...patch };
      // Prune to keep settings clean: default fallback with no extras = no entry.
      if (!next.fallbackStrategy || next.fallbackStrategy === "fallback") {
        delete updated[comboName];
      } else {
        updated[comboName] = next;
      }

      await persistComboStrategies(updated);
    } catch (error) {
      console.log("Error updating combo strategy:", error);
    }
  };

  const handleBulkSetStrategy = async (strategy) => {
    if (selectedCombos.length === 0 || !strategy) return;
    setBulkBusy(true);
    try {
      const updated = { ...comboStrategies };
      for (const combo of selectedCombos) {
        if (!strategy || strategy === "fallback") {
          delete updated[combo.name];
        } else {
          updated[combo.name] = {
            ...(updated[combo.name] || {}),
            fallbackStrategy: strategy,
          };
        }
      }
      await persistComboStrategies(updated);
    } catch (error) {
      console.log("Error bulk updating combo strategy:", error);
      alert("Failed to update strategy for selected combos");
    } finally {
      setBulkBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-text-muted mt-1">
            Group models under one name, then pick a strategy per combo:
          </p>
          <ul className="text-sm text-text-muted mt-2 flex flex-col gap-1">
            <li><span className="font-medium text-text-main">Fallback</span> — tries models in order (next on failure)</li>
            <li><span className="font-medium text-text-main">Round Robin</span> — rotates models across requests to spread load</li>
            <li><span className="font-medium text-text-main">Fusion</span> — queries all models in parallel, then a judge synthesizes one answer. Best quality, but costs the most: every request bills all panel models + the judge (N+1 calls)</li>
          </ul>
          <p className="hidden text-xs text-text-muted mt-3 max-w-2xl">
            <span className="font-medium text-text-main">Cursor / Claude Default</span> create combos named exactly like those clients&apos; model IDs (e.g. <code className="font-mono">composer-2.5</code>, <code className="font-mono">opus</code>), seeded with the matching <code className="font-mono">cu/…</code> or <code className="font-mono">cc/…</code> route so traffic can hit EzRouter without the prefix.
            {" "}Note: Cursor IDE itself often blocks built-in Composer / Grok from Override OpenAI Base URL (&quot;model does not support custom API&quot;); add them via Cursor&apos;s <span className="font-medium text-text-main">Add Custom Model</span> using the combo name, or pick a model Cursor allows through the custom endpoint.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-stretch">
          <Button icon="add" onClick={() => setShowCreateModal(true)} className="w-full sm:w-auto whitespace-nowrap">
            Create Combo
          </Button>
          <div className="hidden">
            <Button
              variant="secondary"
              size="sm"
              icon="edit_note"
              loading={presetLoading === "cursor"}
              disabled={!!presetLoading}
              onClick={() => handleGeneratePresets("cursor")}
              className="w-full whitespace-nowrap"
            >
              Cursor Default
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon="smart_toy"
              loading={presetLoading === "claude"}
              disabled={!!presetLoading}
              onClick={() => handleGeneratePresets("claude")}
              className="w-full whitespace-nowrap"
            >
              Claude Default
            </Button>
          </div>
        </div>
      </div>

      {/* Combos List */}
      {combos.length === 0 ? (
        <Card>
          <div className="text-center py-12">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary mb-4">
              <span className="material-symbols-outlined text-[32px]">layers</span>
            </div>
            <p className="text-text-main font-medium mb-1">No combos yet</p>
            <p className="text-sm text-text-muted mb-4">Create model combos with fallback support</p>
            <Button icon="add" onClick={() => setShowCreateModal(true)} className="w-full sm:w-auto">
              Create Combo
            </Button>
          </div>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {/* Selection toolbar */}
          <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-black/5 bg-black/[0.015] px-3 py-2 dark:border-white/5 dark:bg-white/[0.02] sm:flex-row sm:items-center sm:justify-between">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-text-muted hover:text-primary select-none">
              <input
                type="checkbox"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someSelected && !allSelected;
                }}
                onChange={toggleSelectAll}
                className="h-3.5 w-3.5 rounded border-gray-300 text-primary focus:ring-primary"
              />
              <span>
                {someSelected
                  ? `${selectedIds.length} selected`
                  : `Select all (${combos.length})`}
              </span>
            </label>

            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {someSelected && (
                <>
                  <div className="w-full min-w-[160px] sm:w-[200px]">
                    <Select
                      options={STRATEGY_OPTIONS}
                      value=""
                      placeholder="Set strategy…"
                      disabled={bulkBusy}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v) handleBulkSetStrategy(v);
                      }}
                      selectClassName="py-1.5 text-xs"
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="danger"
                    icon="delete"
                    disabled={bulkBusy}
                    loading={bulkBusy}
                    onClick={handleBulkDelete}
                    className="whitespace-nowrap"
                  >
                    Delete ({selectedIds.length})
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={clearSelection}
                    disabled={bulkBusy}
                  >
                    Clear
                  </Button>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-3">
            {(() => {
              const comboByName = Object.fromEntries(combos.map((c) => [c.name, c.models]));
              return combos.map((combo) => (
                <ComboCard
                  key={combo.id}
                  combo={combo}
                  getCaps={getCaps}
                  comboByName={comboByName}
                  activeProviders={activeProviders}
                  copied={copied}
                  onCopy={copy}
                  onEdit={() => setEditingCombo(combo)}
                  onDelete={() => handleDelete(combo.id)}
                  onTest={() => setTestingCombo(combo)}
                  strategy={comboStrategies[combo.name] || {}}
                  onSetStrategy={(patch) => handleSetComboStrategy(combo.name, patch)}
                  selected={selectedIds.includes(combo.id)}
                  onToggleSelect={() => toggleSelect(combo.id)}
                />
              ));
            })()}
          </div>
        </div>
      )}

      {/* Capacity Adapter */}
      <CapacityAdapterSection
        capacityAdapter={capacityAdapter}
        onChange={handleSetCapacityAdapter}
        activeProviders={activeProviders}
        getCaps={getCaps}
      />

      {/* Combo Test Modal */}
      {testingCombo && (
        <ComboTestModal
          isOpen={!!testingCombo}
          combo={testingCombo}
          onClose={() => setTestingCombo(null)}
          strategy={comboStrategies[testingCombo.name] || {}}
        />
      )}

      {/* Create Modal - Use key to force remount and reset state */}
      {showCreateModal && (
        <ComboFormModal
          key="create"
          isOpen={showCreateModal}
          onClose={() => setShowCreateModal(false)}
          onSave={handleCreate}
          onTestDraft={(draft) => setTestingCombo(draft)}
          activeProviders={activeProviders}
        />
      )}

      {editingCombo && (
        <ComboFormModal
          key={editingCombo.id}
          isOpen={!!editingCombo}
          combo={editingCombo}
          onClose={() => setEditingCombo(null)}
          onSave={(data) => handleUpdate(editingCombo.id, data)}
          onTestDraft={(draft) => setTestingCombo(draft)}
          activeProviders={activeProviders}
        />
      )}

      {/* Confirm (delete / generate presets) */}
      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => !confirmState?.loading && setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        confirmText={confirmState?.confirmText || "Confirm"}
        variant={confirmState?.variant || "danger"}
        loading={!!confirmState?.loading}
      />
    </div>
  );
}

const fmtK = (n) => {
  if (!n) return "?";
  if (n >= 1000000) {
    const m = n / 1000000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  return `${Math.round(n / 1000)}k`;
};

function ComboCard({ combo, getCaps, comboByName = {}, activeProviders = [], copied, onCopy, onEdit, onDelete, onTest, strategy = {}, onSetStrategy, selected = false, onToggleSelect }) {
  const [showJudgeSelect, setShowJudgeSelect] = useState(false);
  const current = strategy.fallbackStrategy || "fallback";
  const judge = strategy.judgeModel || "";
  const isFusion = current === "fusion";
  const comboCaps = aggregateComboCapabilities(combo.models, comboByName);

  return (
    <Card padding="sm" className={`group ${selected ? "ring-1 ring-primary/40 bg-primary/[0.03]" : ""}`}>
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
          <label className="flex shrink-0 items-center pt-1 sm:pt-0 cursor-pointer" title="Select combo">
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelect}
              onClick={(e) => e.stopPropagation()}
              className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
              aria-label={`Select ${combo.name}`}
            />
          </label>
          <div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-primary text-[18px]">layers</span>
          </div>
          <div className="min-w-0 flex-1">
            <code className="block truncate font-mono text-sm font-medium">{combo.name}</code>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
              {combo.models.length === 0 ? (
                <span className="text-xs text-text-muted italic">No models</span>
              ) : (
                combo.models.slice(0, 3).map((model, index) => (
                  <code key={index} className="inline-flex items-center gap-1 rounded bg-black/5 px-1.5 py-0.5 font-mono text-xs text-text-muted dark:bg-white/5">
                    <span>{model}</span>
                    <CapacityBadges caps={
                      comboByName[model]
                        ? aggregateComboCapabilities(comboByName[model], comboByName)
                        : getCaps?.(model)
                    } />
                  </code>
                ))
              )}
              {combo.models.length > 3 && (
                <span className="text-[10px] text-text-muted">+{combo.models.length - 3} more</span>
              )}
            </div>
            {comboCaps && (
              <div className="mt-1 flex items-center gap-2 text-[10px] text-text-muted">
                <span>ctx {fmtK(comboCaps.contextWindow)}</span>
                <span className="opacity-40">·</span>
                <span>max {fmtK(comboCaps.maxOutput)}</span>
              </div>
            )}
            {/* Fusion: judge picker (Auto = first model) */}
            {isFusion && (
              <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-medium text-text-muted">Judge</span>
                <button
                  onClick={() => setShowJudgeSelect(true)}
                  className="inline-flex max-w-full items-center gap-1 rounded border border-dashed border-primary/40 px-1.5 py-0.5 font-mono text-[11px] text-primary hover:border-primary hover:bg-primary/5 transition-colors"
                  title="Pick the model that fuses panel answers"
                >
                  <span className="material-symbols-outlined text-[13px]">gavel</span>
                  <span className="truncate">{judge || `Auto — ${combo.models[0] || "first model"}`}</span>
                </button>
                {judge && (
                  <button
                    onClick={() => onSetStrategy({ judgeModel: "" })}
                    className="p-0.5 rounded text-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors"
                    title="Reset judge to Auto"
                  >
                    <span className="material-symbols-outlined text-[13px]">close</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:gap-3 sm:shrink-0">
          {/* Strategy selector — always visible */}
          <div className="w-full sm:w-[200px]">
            <Select
              options={STRATEGY_OPTIONS}
              value={current}
              onChange={(e) => onSetStrategy({ fallbackStrategy: e.target.value })}
              selectClassName="py-1.5 text-xs"
            />
          </div>

          <div className="grid grid-cols-4 gap-1 sm:flex">
            <button
              onClick={onTest}
              className="flex flex-col items-center rounded px-2 py-1 text-primary transition-colors hover:bg-primary/10"
              title="Test Run Combo"
            >
              <span className="material-symbols-outlined text-[18px]">play_circle</span>
              <span className="text-[10px] leading-tight font-medium">Test</span>
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onCopy(combo.name, `combo-${combo.id}`); }}
              className="flex flex-col items-center rounded px-2 py-1 text-text-muted transition-colors hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"
              title="Copy combo name"
            >
              <span className="material-symbols-outlined text-[18px]">
                {copied === `combo-${combo.id}` ? "check" : "content_copy"}
              </span>
              <span className="text-[10px] leading-tight">Copy</span>
            </button>
            <button
              onClick={onEdit}
              className="flex flex-col items-center rounded px-2 py-1 text-text-muted transition-colors hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"
              title="Edit"
            >
              <span className="material-symbols-outlined text-[18px]">edit</span>
              <span className="text-[10px] leading-tight">Edit</span>
            </button>
            <button
              onClick={onDelete}
              className="flex flex-col items-center rounded px-2 py-1 text-red-500 transition-colors hover:bg-red-500/10"
              title="Delete"
            >
              <span className="material-symbols-outlined text-[18px]">delete</span>
              <span className="text-[10px] leading-tight">Delete</span>
            </button>
          </div>
        </div>
      </div>

      {/* Judge model picker (single-select; combo members make natural judges too) */}
      {showJudgeSelect && (
        <ModelSelectModal
          isOpen={showJudgeSelect}
          onClose={() => setShowJudgeSelect(false)}
          onSelect={(m) => { onSetStrategy({ judgeModel: m?.value || "" }); setShowJudgeSelect(false); }}
          activeProviders={activeProviders}
          title="Select Judge Model"
          addedModelValues={judge ? [judge] : []}
          closeOnSelect={true}
        />
      )}
    </Card>
  );
}

function CapacityAdapterSection({ capacityAdapter, onChange, activeProviders, getCaps }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium">Vision Adapter</p>
          <p className="text-xs text-text-muted mt-0.5">
            Your model can&apos;t read image/audio? Auto-switches to a model in the pool below.
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-4">
        {CAPACITY_ADAPTER_CAPS.map((cap) => (
          <CapacityAdapterCap
            key={cap.key}
            cap={cap}
            entry={capacityAdapter[cap.key] || EMPTY_CAP_ENTRY}
            onChange={(entry) => onChange({ ...capacityAdapter, [cap.key]: entry })}
            activeProviders={activeProviders}
            getCaps={getCaps}
          />
        ))}
      </div>
    </div>
  );
}

function CapacityAdapterCap({ cap, entry, onChange, activeProviders, getCaps }) {
  const [showModelSelect, setShowModelSelect] = useState(false);
  const { enabled, roundRobin, models } = entry;

  const patch = (p) => onChange({ ...entry, ...p });

  const handleAdd = (model) => {
    const value = model?.value || model?.name || model;
    if (!value || models.includes(value)) return;
    patch({ models: [...models, value] });
  };

  const handleDeselect = (model) => {
    const value = model?.value || model?.name || model;
    const next = models.filter((m) => m !== value);
    patch({ models: next.length === 0 ? [DEFAULT_FALLBACK_MODEL] : next });
  };

  const handleRemove = (index) => {
    const next = models.filter((_, i) => i !== index);
    patch({ models: next.length === 0 ? [DEFAULT_FALLBACK_MODEL] : next });
  };

  const handleMove = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= models.length) return;
    const next = [...models];
    [next[index], next[target]] = [next[target], next[index]];
    patch({ models: next });
  };

  return (
    <Card padding="sm" className={`group ${!enabled ? "opacity-50" : ""}`}>
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Master toggle + icon + label */}
        <div className="flex min-w-0 flex-1 items-start gap-2.5 sm:items-center">
          <Toggle
            checked={enabled}
            onChange={(v) => patch({ enabled: v })}
            aria-label={`Enable ${cap.label} adapter`}
          />
          <div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-primary text-[18px]">{cap.icon}</span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <code className="font-mono text-sm font-medium">{cap.label}</code>
              <span className="text-[10px] text-text-muted">— {cap.desc}</span>
            </div>
          </div>
        </div>

        {/* Actions: Round-robin toggle + Add Model */}
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:gap-3 sm:shrink-0">
          <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer select-none">
            <Toggle
              checked={roundRobin}
              onChange={(v) => patch({ roundRobin: v })}
              disabled={!enabled}
              aria-label={`Round-robin ${cap.label} adapter`}
            />
            <span>Round</span>
          </label>
          <Button
            icon="add"
            variant="ghost"
            size="sm"
            onClick={() => setShowModelSelect(true)}
            disabled={!enabled}
            title={`Add ${cap.label} model`}
          >
            Add Model
          </Button>
        </div>
      </div>

      {/* Model pool list/table */}
      {models.length === 0 ? (
        <div className="mt-3 py-2 text-center text-xs text-text-muted italic">
          No models in pool (will fallback to {DEFAULT_FALLBACK_MODEL})
        </div>
      ) : (
        <div className="mt-3 overflow-hidden rounded-lg border border-border/50">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border/40 bg-black/[0.02] text-text-muted dark:bg-white/[0.02]">
                <th className="w-12 px-3 py-1.5 font-medium text-center">#</th>
                <th className="px-3 py-1.5 font-medium">Model</th>
                <th className="w-24 px-3 py-1.5 font-medium text-center">Order</th>
                <th className="w-12 px-3 py-1.5 font-medium text-right"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30 font-mono">
              {models.map((model, index) => (
                <tr key={`${model}-${index}`} className="hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
                  <td className="px-3 py-2 text-center text-text-muted text-[11px] font-sans">
                    #{index + 1}
                  </td>
                  <td className="px-3 py-2 text-text-main">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="truncate">{model}</span>
                      <CapacityBadges caps={getCaps?.(model)} />
                      {model === DEFAULT_FALLBACK_MODEL && (
                        <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-sans text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                          free default
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleMove(index, -1)}
                        disabled={!enabled || index === 0}
                        className={`p-1 rounded transition-colors ${
                          !enabled || index === 0
                            ? "text-text-muted/20 cursor-not-allowed"
                            : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"
                        }`}
                        title="Move up"
                      >
                        <span className="material-symbols-outlined text-[16px] leading-none">arrow_upward</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMove(index, 1)}
                        disabled={!enabled || index === models.length - 1}
                        className={`p-1 rounded transition-colors ${
                          !enabled || index === models.length - 1
                            ? "text-text-muted/20 cursor-not-allowed"
                            : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"
                        }`}
                        title="Move down"
                      >
                        <span className="material-symbols-outlined text-[16px] leading-none">arrow_downward</span>
                      </button>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => handleRemove(index)}
                      disabled={!enabled}
                      className={`p-1 rounded transition-colors ${
                        !enabled
                          ? "text-text-muted/20 cursor-not-allowed"
                          : "text-text-muted hover:text-red-500 hover:bg-red-500/10"
                      }`}
                      title="Remove model"
                    >
                      <span className="material-symbols-outlined text-[16px] leading-none">close</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModelSelect && (
        <ModelSelectModal
          isOpen={showModelSelect}
          onClose={() => setShowModelSelect(false)}
          onSelect={handleAdd}
          onDeselect={handleDeselect}
          activeProviders={activeProviders}
          title={`Add ${cap.label} Model`}
          addedModelValues={models}
          capFilter={cap.key}
          closeOnSelect={false}
        />
      )}
    </Card>
  );
}

function ModelItem({ id, index, model, weight = 1, isFirst, isLast, onEdit, onWeightChange, onMoveUp, onMoveDown, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    // no transition — prevents the CSS settle animation fighting React's re-render on drop
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 999 : undefined,
  };
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(model);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== model) onEdit(trimmed);
    else setDraft(model);
    setEditing(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") { setDraft(model); setEditing(false); }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 bg-black/[0.02] hover:bg-black/[0.04] dark:bg-white/[0.02] dark:hover:bg-white/[0.04] transition-colors ${isDragging ? "shadow-md ring-1 ring-primary/30" : ""}`}
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        type="button"
        className="cursor-grab touch-none p-0.5 rounded text-text-muted hover:text-primary active:cursor-grabbing shrink-0"
        title="Drag to reorder"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="4" r="2"/><circle cx="15" cy="4" r="2"/>
          <circle cx="9" cy="12" r="2"/><circle cx="15" cy="12" r="2"/>
          <circle cx="9" cy="20" r="2"/><circle cx="15" cy="20" r="2"/>
        </svg>
      </button>

      {/* Index badge */}
      <span className="text-[10px] font-medium text-text-muted w-3 text-center shrink-0">{index + 1}</span>

      {/* Inline editable model value */}
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          className="min-w-0 flex-1 rounded border border-primary/40 bg-white px-1.5 py-0.5 font-mono text-xs text-text-main outline-none dark:bg-black/20"
        />
      ) : (
        <div
          className="min-w-0 flex-1 cursor-text truncate rounded px-1.5 py-0.5 font-mono text-xs text-text-main hover:bg-black/5 dark:hover:bg-white/5"
          onClick={() => setEditing(true)}
          title="Click to edit"
        >
          {model}
        </div>
      )}

      {/* Weight (1-10) */}
      <label className="flex shrink-0 items-center gap-0.5 text-[10px] text-text-muted" title="Weight for Weighted strategy">
        w
        <input type="number" min={1} max={10} value={weight} onChange={(e) => onWeightChange?.(e.target.value)} className="w-9 rounded border border-black/10 px-1 py-0.5 text-xs text-text-main dark:border-white/10 bg-transparent text-center" />
      </label>

      {/* Priority arrows */}
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          onClick={onMoveUp}
          disabled={isFirst}
          className={`p-0.5 rounded ${isFirst ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`}
          title="Move up"
        >
          <span className="material-symbols-outlined text-[12px]">arrow_upward</span>
        </button>
        <button
          onClick={onMoveDown}
          disabled={isLast}
          className={`p-0.5 rounded ${isLast ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`}
          title="Move down"
        >
          <span className="material-symbols-outlined text-[12px]">arrow_downward</span>
        </button>
      </div>

      {/* Remove */}
      <button
        onClick={onRemove}
        className="p-0.5 hover:bg-red-500/10 rounded text-text-muted hover:text-red-500 transition-all"
        title="Remove"
      >
        <span className="material-symbols-outlined text-[12px]">close</span>
      </button>
    </div>
  );
}

function ComboFormModal({ isOpen, combo, onClose, onSave, onTestDraft, activeProviders, kindFilter = null }) {
  // Initialize state with combo values - key prop on parent handles reset on remount
  const [name, setName] = useState(combo?.name || "");
  const initialMembers = combo?.members?.length ? combo.members : (combo?.models || []).map((id) => ({ id, weight: 1 }));
  const [members, setMembers] = useState(initialMembers);
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState("");
  const [modelAliases, setModelAliases] = useState({});
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [advPolicy, setAdvPolicy] = useState(() => combo?.policy || combo?.config?.policy || {});
  const [advFusion, setAdvFusion] = useState(() => combo?.fusion || combo?.config?.fusion || {});

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Use stable index-based IDs so duplicates and similar names are handled correctly
  const modelItems = members.map((m, i) => ({ uid: `item-${i}`, id: m.id, weight: m.weight }));
  const models = members.map((m) => m.id);

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = modelItems.findIndex((m) => m.uid === active.id);
      const newIndex = modelItems.findIndex((m) => m.uid === over.id);
      if (oldIndex !== -1 && newIndex !== -1) {
        setMembers((prev) => arrayMove(prev, oldIndex, newIndex));
      }
    }
  };

  const fetchModalData = async () => {
    try {
      const aliasesRes = await fetch("/api/models/alias");
      if (!aliasesRes.ok) return;
      const aliasesData = await aliasesRes.json();
      setModelAliases(aliasesData.aliases || {});
    } catch (error) {
      console.error("Error fetching modal data:", error);
    }
  };

  useEffect(() => {
    if (isOpen) fetchModalData();
  }, [isOpen]);

  const validateName = (value) => {
    if (!value.trim()) {
      setNameError("Name is required");
      return false;
    }
    if (!VALID_NAME_REGEX.test(value)) {
      setNameError("Only letters, numbers, -, _ and . allowed");
      return false;
    }
    setNameError("");
    return true;
  };

  const handleNameChange = (e) => {
    const value = e.target.value;
    setName(value);
    if (value) validateName(value);
    else setNameError("");
  };

  const handleAddModel = (model) => {
    if (!members.find((m) => m.id === model.value)) {
      setMembers([...members, { id: model.value, weight: 1 }]);
    }
  };

  const handleDeselectModel = (model) => {
    setMembers(members.filter((m) => m.id !== model.value));
  };

  const handleRemoveModel = (index) => {
    setMembers(members.filter((_, i) => i !== index));
  };

  const handleMoveUp = (index) => {
    if (index === 0) return;
    const next = [...members];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    setMembers(next);
  };

  const handleMoveDown = (index) => {
    if (index === members.length - 1) return;
    const next = [...members];
    [next[index], next[index + 1]] = [next[index + 1], next[index]];
    setMembers(next);
  };

  const handleWeightChange = (index, w) => {
    const weight = Math.max(1, Math.min(10, parseInt(w, 10) || 1));
    const next = [...members];
    next[index] = { ...next[index], weight };
    setMembers(next);
  };

  const handleSave = async () => {
    if (!validateName(name)) return;
    setSaving(true);
    const models = members.map((m) => m.id);
    const hasWeights = members.some((m) => (m.weight || 1) !== 1);
    const payload = { name: name.trim(), models };
    if (hasWeights || Object.keys(advPolicy).length || Object.keys(advFusion).length) {
      payload.members = members;
      const cfg = {};
      if (hasWeights) cfg.members = members;
      if (Object.keys(advPolicy).length) cfg.policy = advPolicy;
      if (Object.keys(advFusion).length) cfg.fusion = advFusion;
      if (Object.keys(cfg).length) payload.config = cfg;
    }
    await onSave(payload);
    setSaving(false);
  };

  const isEdit = !!combo;

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={isEdit ? "Edit Combo" : "Create Combo"}
      >
        <div className="flex flex-col gap-3">
          {/* Name */}
          <div>
            <Input
              label="Combo Name"
              value={name}
              onChange={handleNameChange}
              placeholder="my-combo"
              error={nameError}
            />
            <p className="text-[10px] text-text-muted mt-0.5">
              Only letters, numbers, -, _ and . allowed
            </p>
          </div>

          {/* Models */}
          <div>
            <label className="text-sm font-medium mb-1.5 block">Models <span className="text-[11px] text-text-muted font-normal">— weights matter for Weighted strategy</span></label>

            {members.length === 0 ? (
              <div className="text-center py-4 border border-dashed border-black/10 dark:border-white/10 rounded-lg bg-black/[0.01] dark:bg-white/[0.01]">
                <span className="material-symbols-outlined text-text-muted text-xl mb-1">layers</span>
                <p className="text-xs text-text-muted">No models added yet</p>
              </div>
            ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd} modifiers={[restrictToVerticalAxis, restrictToParentElement]}>
              <SortableContext items={modelItems.map((m) => m.uid)} strategy={verticalListSortingStrategy}>
                <div className="flex max-h-[55vh] min-w-0 flex-col gap-1 overflow-y-auto sm:max-h-[350px]">
                  {modelItems.map(({ uid, id, weight }, index) => (
                    <ModelItem
                      key={uid}
                      id={uid}
                      index={index}
                      model={id}
                      weight={weight}
                      isFirst={index === 0}
                      isLast={index === modelItems.length - 1}
                      onEdit={(newVal) => {
                        const updated = [...members];
                        updated[index] = { ...updated[index], id: newVal };
                        setMembers(updated);
                      }}
                      onWeightChange={(w) => handleWeightChange(index, w)}
                      onMoveUp={() => handleMoveUp(index)}
                      onMoveDown={() => handleMoveDown(index)}
                      onRemove={() => handleRemoveModel(index)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
            )}

            {/* Add Model button */}
            <button
              onClick={() => setShowModelSelect(true)}
              className="w-full mt-2 py-2 border border-dashed border-black/10 dark:border-white/10 rounded-lg text-xs text-primary font-medium hover:text-primary hover:border-primary/50 transition-colors flex items-center justify-center gap-1"
            >
              <span className="material-symbols-outlined text-[16px]">add</span>
              Add Model
            </button>

            {/* Advanced: weights sticky, maxHops, fusion tuning */}
            <div className="rounded-lg border border-black/10 dark:border-white/10 p-2">
              <button type="button" onClick={() => setShowAdvanced((v) => !v)} className="flex w-full items-center justify-between text-xs font-medium text-text-main">
                <span>Advanced — weights, retry, fusion tuning</span>
                <span className="material-symbols-outlined text-[16px]">{showAdvanced ? "expand_less" : "expand_more"}</span>
              </button>
              {showAdvanced && (
                <div className="mt-2 flex flex-col gap-2">
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-xs">Sticky (requests per model)
                      <input type="number" min={1} max={50} value={advPolicy.sticky || 1} onChange={(e) => setAdvPolicy({ ...advPolicy, sticky: Math.max(1, parseInt(e.target.value, 10) || 1) })} className="mt-1 w-full rounded border border-black/10 px-2 py-1 text-xs dark:border-white/10 bg-transparent" />
                    </label>
                    <label className="text-xs">Max Hops (attempts)
                      <input type="number" min={1} max={20} placeholder="all" value={advPolicy.maxHops || ""} onChange={(e) => { const v = parseInt(e.target.value, 10); setAdvPolicy(v ? { ...advPolicy, maxHops: v } : { ...advPolicy, maxHops: undefined }); }} className="mt-1 w-full rounded border border-black/10 px-2 py-1 text-xs dark:border-white/10 bg-transparent" />
                    </label>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <label className="text-xs">Min Panel
                      <input type="number" min={2} max={10} value={advFusion.minPanel || ""} placeholder="2" onChange={(e) => { const v = parseInt(e.target.value, 10); setAdvFusion(v ? { ...advFusion, minPanel: v } : { ...advFusion, minPanel: undefined }); }} className="mt-1 w-full rounded border border-black/10 px-2 py-1 text-xs dark:border-white/10 bg-transparent" />
                    </label>
                    <label className="text-xs">Grace ms
                      <input type="number" min={0} max={30000} value={advFusion.stragglerGraceMs || ""} placeholder="8000" onChange={(e) => { const v = parseInt(e.target.value, 10); setAdvFusion(Number.isFinite(v) ? { ...advFusion, stragglerGraceMs: v } : { ...advFusion, stragglerGraceMs: undefined }); }} className="mt-1 w-full rounded border border-black/10 px-2 py-1 text-xs dark:border-white/10 bg-transparent" />
                    </label>
                    <label className="text-xs">Hard timeout ms
                      <input type="number" min={1000} max={300000} value={advFusion.panelHardTimeoutMs || ""} placeholder="90000" onChange={(e) => { const v = parseInt(e.target.value, 10); setAdvFusion(Number.isFinite(v) ? { ...advFusion, panelHardTimeoutMs: v } : { ...advFusion, panelHardTimeoutMs: undefined }); }} className="mt-1 w-full rounded border border-black/10 px-2 py-1 text-xs dark:border-white/10 bg-transparent" />
                    </label>
                  </div>
                  <p className="text-[10px] text-text-muted">Weights 1–10 affect Weighted strategy only. Sticky & Max Hops affect fallback/round-robin. Fusion tuning affects panel collection.</p>
                </div>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-2 pt-1 sm:flex-row">
            <Button onClick={onClose} variant="ghost" fullWidth size="sm">
              Cancel
            </Button>
            {onTestDraft && models.length > 0 && (
              <Button
                type="button"
                onClick={() => onTestDraft({ id: combo?.id, name: name || "Draft Combo", models, kind: kindFilter || "llm" })}
                variant="outline"
                fullWidth
                size="sm"
                icon="play_circle"
              >
                Test Run
              </Button>
            )}
            <Button
              onClick={handleSave}
              fullWidth
              size="sm"
              disabled={!name.trim() || !!nameError || saving}
            >
              {saving ? "Saving..." : isEdit ? "Save" : "Create"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Model Select Modal */}
      {showModelSelect && (
        <ModelSelectModal
          isOpen={showModelSelect}
          onClose={() => setShowModelSelect(false)}
          onSelect={handleAddModel}
          onDeselect={handleDeselectModel}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title="Add Model to Combo"
          kindFilter={kindFilter}
          addedModelValues={members.map((m) => m.id)}
          closeOnSelect={false}
        />
      )}
    </>
  );
}
