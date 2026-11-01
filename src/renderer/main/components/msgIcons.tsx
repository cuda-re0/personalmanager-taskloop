import type { ReactElement } from 'react'

/**
 * 气泡与操作行用的小图标（v0.49 §5.1）。
 *
 * 六条统一约束：`viewBox="0 0 24 24"`、`fill="none"`、`stroke="currentColor"`、
 * `strokeWidth={1.7}`、圆头圆角连接、**不加 `<title>`、不加文字**——尺寸由 CSS 给，
 * 无障碍名称由外层按钮的 `aria-label` 承担。
 */

export function ImageGlyphIcon(): ReactElement {
  return (
    <svg
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.7}
      viewBox="0 0 24 24"
    >
      <rect height="16" rx="2.5" width="18" x="3" y="4" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="M21 16l-4.5-4.5L9 19" />
    </svg>
  )
}

export function FileGlyphIcon(): ReactElement {
  return (
    <svg
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.7}
      viewBox="0 0 24 24"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  )
}

export function CopyIcon(): ReactElement {
  return (
    <svg
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.7}
      viewBox="0 0 24 24"
    >
      <rect height="12" rx="2" width="10" x="9" y="9" />
      <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
    </svg>
  )
}

export function CheckIcon(): ReactElement {
  return (
    <svg
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.7}
      viewBox="0 0 24 24"
    >
      <path d="M4 12.5l5 5L20 6.5" />
    </svg>
  )
}

export function UndoIcon(): ReactElement {
  return (
    <svg
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.7}
      viewBox="0 0 24 24"
    >
      <path d="M4 9h10a5 5 0 0 1 0 10h-4" />
      <path d="M8 5L4 9l4 4" />
    </svg>
  )
}

export function PencilIcon(): ReactElement {
  return (
    <svg
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.7}
      viewBox="0 0 24 24"
    >
      <path d="M4 20h4L19 9a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5z" />
      <path d="M14.5 6.5L17.5 9.5" />
    </svg>
  )
}
