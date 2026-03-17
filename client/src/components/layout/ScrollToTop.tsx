import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";

export function ScrollToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const container = document.querySelector("[data-scroll-container]");
    if (!container) return;

    const handleScroll = () => {
      setVisible(container.scrollTop > 400);
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  if (!visible) return null;

  return (
    <Button
      size="icon"
      variant="outline"
      className={cn(
        "fixed bottom-6 left-6 z-50 h-10 w-10 rounded-full shadow-lg",
        "bg-background/95 backdrop-blur-sm border",
        "animate-in fade-in slide-in-from-bottom-2 duration-200"
      )}
      onClick={() => {
        const container = document.querySelector("[data-scroll-container]");
        container?.scrollTo({ top: 0, behavior: "smooth" });
      }}
      aria-label="Scroll to top"
    >
      <ArrowUp className="h-4 w-4" />
    </Button>
  );
}
