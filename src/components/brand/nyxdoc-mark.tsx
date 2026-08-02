/* eslint-disable @next/next/no-img-element -- The tiny local SVG is already the final optimized brand asset. */

export function NyxdocMark({
  size,
  className,
}: {
  size: number;
  className?: string;
}) {
  return (
    <img
      aria-hidden="true"
      className={className}
      src="/nyxdoc-mark.svg"
      width={size}
      height={size}
      alt=""
    />
  );
}
