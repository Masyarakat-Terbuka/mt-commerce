import { cn } from "@/lib/utils"
import { HugeiconsIcon } from "@hugeicons/react"
import { Loading03Icon } from "@hugeicons/core-free-icons"

// The preset spread `React.ComponentProps<"svg">` directly onto HugeiconsIcon,
// which expects narrower numeric props (e.g. width is `number | undefined`,
// not the SVG element's `number | string`). We pin the prop shape to the
// HugeiconsIcon component so TypeScript stays happy and the call site keeps
// the same surface (className + arbitrary icon props).
type SpinnerProps = Omit<
  React.ComponentProps<typeof HugeiconsIcon>,
  "icon" | "role" | "aria-label"
>

function Spinner({ className, ...props }: SpinnerProps) {
  return (
    <HugeiconsIcon
      icon={Loading03Icon}
      strokeWidth={2}
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
