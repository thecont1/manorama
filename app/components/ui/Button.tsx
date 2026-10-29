import type { JSX } from 'hono/jsx'

/** Redesign pill button. Variants: primary (neutral inversion), secondary
 *  (raised), quiet (transparent), destructive (negative ink). */
export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'destructive'

type Props = JSX.HTMLAttributes & {
  variant?: ButtonVariant
  block?: boolean
}

export function Button({ variant = 'secondary', block = false, type = 'button', class: cls, ...rest }: Props) {
  const classes = ['m-btn', `m-btn--${variant}`, block ? 'm-btn--block' : '', cls ?? ''].filter(Boolean).join(' ')
  return <button type={type as 'button' | 'submit' | 'reset'} class={classes} {...rest} />
}

export default Button
