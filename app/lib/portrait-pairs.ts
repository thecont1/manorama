/**
 * Photography-first pairing: only immediately consecutive portrait originals
 * share a canvas. Pairing preserves every source item and its stable index.
 */
export type PortraitPairItem<T> = { image: T; imageIndex: number }
export type PortraitPairGroup<T> = {
  kind: 'single' | 'portrait-pair'
  items: PortraitPairItem<T>[]
}

type Dimensions = { width: number; height: number }

const isPortrait = (image: Dimensions) => image.height > image.width

export function groupConsecutivePortraits<T extends Dimensions>(images: readonly T[]): PortraitPairGroup<T>[] {
  const groups: PortraitPairGroup<T>[] = []
  let imageIndex = 0

  while (imageIndex < images.length) {
    const current = images[imageIndex]
    const following = images[imageIndex + 1]
    if (current && following && isPortrait(current) && isPortrait(following)) {
      groups.push({
        kind: 'portrait-pair',
        items: [{ image: current, imageIndex }, { image: following, imageIndex: imageIndex + 1 }],
      })
      imageIndex += 2
      continue
    }
    if (current) groups.push({ kind: 'single', items: [{ image: current, imageIndex }] })
    imageIndex += 1
  }

  return groups
}
