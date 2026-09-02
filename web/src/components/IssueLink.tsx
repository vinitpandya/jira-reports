import type { CSSProperties, ReactNode } from 'react'
import { useScope } from '../lib/scope'

const KEY_RE = /^([A-Z][A-Z0-9_]+-\d+)(\s+|$)/

/** Deep link to an issue in Jira; degrades to plain text before a site is known. */
export function IssueLink({
  issueKey,
  children,
  className,
  style,
}: {
  issueKey: string
  children?: ReactNode
  className?: string
  style?: CSSProperties
}) {
  const { siteUrl } = useScope()
  if (!siteUrl) return <span className={className} style={style}>{children ?? issueKey}</span>
  return (
    <a
      href={`${siteUrl}/browse/${issueKey}`}
      target="_blank"
      rel="noreferrer"
      className={className}
      style={style}
      title={`Open ${issueKey} in Jira`}
      onClick={(e) => e.stopPropagation()}
    >
      {children ?? issueKey}
    </a>
  )
}

/**
 * Names like "PAY-12 Checkout redesign" get their key linked and the summary
 * left as text; anything else renders unchanged.
 */
export function LinkedName({ name, max }: { name: string; max?: number }) {
  const m = KEY_RE.exec(name)
  const text = max && name.length > max ? `${name.slice(0, max - 1)}…` : name
  if (!m) return <>{text}</>
  const rest = text.slice(m[1].length)
  return (
    <>
      <IssueLink issueKey={m[1]} />
      {rest}
    </>
  )
}
