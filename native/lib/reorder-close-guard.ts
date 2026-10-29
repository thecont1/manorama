let closeGuard: (() => boolean) | null = null

/** The mounted Reorder island owns the dirty guard. Returning true means the
 * shell must swallow this back request while the confirmation is presented. */
export const installReorderCloseGuard = (guard: () => boolean) => {
  closeGuard = guard
  return () => {
    if (closeGuard === guard) closeGuard = null
  }
}

export const requestReorderClose = (): boolean => closeGuard?.() ?? false
