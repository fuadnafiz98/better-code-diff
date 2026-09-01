import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'

const GITHUB_MARKDOWN_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'details', 'summary'],
  attributes: {
    ...defaultSchema.attributes,
    details: [...(defaultSchema.attributes?.details ?? []), 'open']
  }
}

export function resolveGitHubHref(href: string | undefined): string | undefined {
  if (href?.startsWith('/') === true) return `https://github.com${href}`
  return href
}

export const GitHubMarkdownContent = memo(function GitHubMarkdownContent({
  source,
  className,
  variant = 'document'
}: {
  source: string
  className?: string
  variant?: 'document' | 'comment'
}): React.JSX.Element {
  const classes = [
    className,
    'gh-markdown',
    variant === 'comment' ? 'comment' : null
  ].filter((value): value is string => value != null && value !== '').join(' ')
  return (
    <div className={classes}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, GITHUB_MARKDOWN_SCHEMA]]}
        components={{
          a: ({ href, children, ...props }) => {
            const resolvedHref = resolveGitHubHref(href)
            const external = resolvedHref?.startsWith('https://') === true
            return (
              <a {...props} href={resolvedHref}
                {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
                {children}
              </a>
            )
          }
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
})
