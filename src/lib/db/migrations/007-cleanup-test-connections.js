export default {
  version: 7,
  name: "cleanup-test-connections",
  up(db) {
    db.run(
      `DELETE FROM providerConnections WHERE (provider LIKE 'openai-compatible-%' AND (name LIKE 'seed-%' OR provider LIKE 'openai-compatible-ord-%' OR provider LIKE 'openai-compatible-seq-%' OR provider LIKE 'openai-compatible-del-%' OR provider LIKE 'openai-compatible-upd-%' OR provider LIKE 'openai-compatible-clash-%' OR provider = 'openai-compatible-other')) OR provider = 'kimchi-nope' OR (email LIKE '%@example.com' AND name LIKE 'guard-%')`
    );
  },
};
