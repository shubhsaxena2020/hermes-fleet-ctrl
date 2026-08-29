/**
 * hermes-fleet-ctrl — entry point (scaffold).
 *
 * Phase A establishes the project skeleton, toolchain, and a minimal runnable
 * entry point. Real driver/TUI logic lands in later milestones.
 */

export const APP_NAME = 'hermes-fleet-ctrl' as const;
export const APP_VERSION = '0.1.0' as const;

export function main(): void {
  // eslint-disable-next-line no-console
  console.info(`[${APP_NAME}] v${APP_VERSION} booting (scaffold)`);
}

// Run only when executed directly (NodeNext ESM equivalent of require.main === module).
const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main();
}
