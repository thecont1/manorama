export const ogImageType = (image: string): string => {
  const pathname = image.startsWith('http') ? new URL(image).pathname : image.split(/[?#]/, 1)[0]!
  const extension = pathname.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  switch (extension) {
    case 'png': return 'image/png'
    case 'webp': return 'image/webp'
    case 'avif': return 'image/avif'
    case 'gif': return 'image/gif'
    default: return 'image/jpeg'
  }
}

export const encryptedGalleryDescription = ({ count, provider, date }: { count: number; provider: string; date: string }): string =>
  [`${count} photograph${count === 1 ? '' : 's'}`, ...(date.trim() ? [date.trim()] : []), provider].join(' · ')
