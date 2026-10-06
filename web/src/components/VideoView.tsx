// A video file tab: the native player streaming ranged bytes from the server, paused whenever the
// tab stops showing, or a card when Chromium can't decode the format.
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { RevealIcon } from "@/components/ui";
import { api } from "../lib/api.ts";

export function VideoView({
  threadId,
  path,
  showing,
  version,
}: {
  threadId: string;
  path: string;
  showing: boolean;
  version: number;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!showing) ref.current?.pause();
  }, [showing]);

  useEffect(() => {
    setFailed(false);
  }, [version]);

  if (failed) {
    const mac = document.documentElement.classList.contains("mac");
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-card p-6 text-center">
          <p className="text-[13px] font-medium text-foreground">{path.split("/").pop()}</p>
          <p className="text-[12px] text-muted-foreground">This video format can't be played here.</p>
          {mac ? (
            <Button variant="outline" size="sm" onClick={() => void api.revealEntry(threadId, path).catch(() => {})}>
              <RevealIcon />
              Reveal in Finder
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-black">
      <video
        ref={ref}
        src={`/api/threads/${threadId}/video?path=${encodeURIComponent(path)}&v=${version}`}
        controls
        preload="metadata"
        playsInline
        className="max-h-full max-w-full"
        onError={() => setFailed(true)}
        onLoadedMetadata={(event) => {
          if (event.currentTarget.videoWidth === 0) setFailed(true);
        }}
      />
    </div>
  );
}
