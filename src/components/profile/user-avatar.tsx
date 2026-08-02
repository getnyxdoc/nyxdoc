"use client";

import { useState } from "react";

function firstCharacter(name: string) {
  return Array.from(name.trim())[0]?.toUpperCase() ?? "?";
}

function AvatarImage({ name, src }: { name: string; src: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) return <span>{firstCharacter(name)}</span>;
  return (
    // The authenticated media route needs the browser's session cookie,
    // which the Next image optimizer does not forward.
    // eslint-disable-next-line @next/next/no-img-element
    <img alt="" src={src} onError={() => setFailed(true)} />
  );
}

export function UserAvatar({
  className,
  imageUrl,
  name,
}: {
  className: string;
  imageUrl: string | null;
  name: string;
}) {
  return (
    <span className={className} aria-hidden="true">
      {imageUrl ? (
        <AvatarImage key={imageUrl} name={name} src={imageUrl} />
      ) : (
        <span>{firstCharacter(name)}</span>
      )}
    </span>
  );
}
