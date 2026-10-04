export function updateComboStrategy(strategies, comboName, patch) {
  const updated = { ...strategies };
  if (patch.fallbackStrategy === "inherit") {
    delete updated[comboName];
  } else {
    updated[comboName] = { ...(updated[comboName] || {}), ...patch };
  }
  return updated;
}
