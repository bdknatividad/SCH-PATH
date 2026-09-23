"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "./utils";

function Tabs({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  );
}

function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      // The strip must never be wider than the screen.
      //
      // It is `w-fit`, so it is exactly as wide as its tabs. Once a module had
      // four or five of them (Health: All / Assessments / Medications /
      // Treatments) the strip was wider than a phone viewport, and because
      // nothing here scrolled, it pushed the whole page sideways — the tabs at
      // the end were simply unreachable, and the page dragged left/right.
      //
      // `max-w-full` caps it at the container and `overflow-x-auto` scrolls the
      // remainder inside the strip, so the page itself never moves.
      //
      // `justify-start`, not `justify-center`: a centred flex container that
      // overflows pushes its *first* items out of the scrollable area, which
      // makes the first tab unreachable instead of the last. When the strip does
      // fit, `w-fit` makes the two indistinguishable.
      className={cn(
        "bg-muted text-muted-foreground inline-flex h-9 w-fit max-w-full items-center justify-start overflow-x-auto rounded-xl p-[3px] flex",
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "data-[state=active]:bg-green-600 data-[state=active]:text-white data-[state=active]:shadow-sm text-green-700 dark:text-muted-foreground inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-xl border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
