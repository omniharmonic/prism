import { useState, useCallback, useMemo } from "react";
import { Plus, Grid, Edit3, ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  rectSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { RendererProps } from "./RendererProps";
import { useAutoSave } from "../../app/hooks/useAutoSave";
import { Button } from "../ui/Button";

// Parse markdown slides split by ---
function parseSlides(content: string): string[] {
  return content
    .split(/\n---\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function serializeSlides(slides: string[]): string {
  return slides.join("\n\n---\n\n");
}

export default function PresentationRenderer({ note }: RendererProps) {
  const initialSlides = useMemo(() => parseSlides(note.content), [note.id]);
  const [slides, setSlides] = useState<string[]>(initialSlides);
  const [view, setView] = useState<"grid" | "edit">("grid");
  const [activeSlide, setActiveSlide] = useState(0);
  const contentRef = { current: serializeSlides(slides) };

  const getContent = useCallback(() => serializeSlides(slides), [slides]);
  const { scheduleSave } = useAutoSave(note.id, getContent);

  const updateSlides = useCallback((newSlides: string[]) => {
    setSlides(newSlides);
    contentRef.current = serializeSlides(newSlides);
    scheduleSave();
  }, [scheduleSave]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = slides.findIndex((_, i) => `slide-${i}` === active.id);
    const newIndex = slides.findIndex((_, i) => `slide-${i}` === over.id);
    updateSlides(arrayMove(slides, oldIndex, newIndex));
  }, [slides, updateSlides]);

  const addSlide = () => {
    const newSlides = [...slides, "# New Slide"];
    updateSlides(newSlides);
    setActiveSlide(newSlides.length - 1);
    setView("edit");
  };

  const deleteSlide = (index: number) => {
    if (slides.length <= 1) return;
    const newSlides = slides.filter((_, i) => i !== index);
    updateSlides(newSlides);
    if (activeSlide >= newSlides.length) setActiveSlide(newSlides.length - 1);
  };

  const updateSlideContent = (index: number, content: string) => {
    const newSlides = [...slides];
    newSlides[index] = content;
    updateSlides(newSlides);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div
        className="flex items-center justify-between px-4 py-2 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            {slides.length} slide{slides.length !== 1 ? "s" : ""}
          </span>
          <div className="flex rounded-md overflow-hidden" style={{ border: "1px solid var(--glass-border)" }}>
            <button
              onClick={() => setView("grid")}
              className="p-1.5"
              style={{ background: view === "grid" ? "var(--glass-active)" : "transparent" }}
            >
              <Grid size={14} style={{ color: "var(--text-primary)" }} />
            </button>
            <button
              onClick={() => setView("edit")}
              className="p-1.5"
              style={{ background: view === "edit" ? "var(--glass-active)" : "transparent" }}
            >
              <Edit3 size={14} style={{ color: "var(--text-primary)" }} />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={addSlide}>
            Add Slide
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {view === "grid" ? (
          <SlideGrid
            slides={slides}
            activeSlide={activeSlide}
            onSelect={(i) => { setActiveSlide(i); setView("edit"); }}
            onDragEnd={handleDragEnd}
            onDelete={deleteSlide}
            sensors={sensors}
          />
        ) : (
          <SlideEditor
            slides={slides}
            activeSlide={activeSlide}
            onChangeSlide={setActiveSlide}
            onUpdateContent={updateSlideContent}
          />
        )}
      </div>
    </div>
  );
}

function SlideGrid({
  slides, activeSlide, onSelect, onDragEnd, onDelete, sensors,
}: {
  slides: string[];
  activeSlide: number;
  onSelect: (i: number) => void;
  onDragEnd: (e: DragEndEvent) => void;
  onDelete: (i: number) => void;
  sensors: ReturnType<typeof useSensors>;
}) {
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={slides.map((_, i) => `slide-${i}`)} strategy={rectSortingStrategy}>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 p-6">
          {slides.map((content, i) => (
            <SortableSlide
              key={`slide-${i}`}
              id={`slide-${i}`}
              index={i}
              content={content}
              isActive={i === activeSlide}
              onSelect={() => onSelect(i)}
              onDelete={() => onDelete(i)}
              canDelete={slides.length > 1}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableSlide({
  id, index, content, isActive, onSelect, onDelete, canDelete,
}: {
  id: string;
  index: number;
  content: string;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
  canDelete: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onSelect}
      className="group relative cursor-pointer"
    >
      <div
        className="aspect-video rounded-lg p-4 overflow-hidden"
        style={{
          background: "var(--bg-elevated)",
          border: isActive ? "2px solid var(--color-accent)" : "1px solid var(--glass-border)",
        }}
      >
        <div
          className="text-xs leading-relaxed overflow-hidden h-full"
          style={{ color: "var(--text-secondary)", fontFamily: "var(--font-sans)" }}
        >
          {content.split("\n").map((line, j) => {
            if (line.startsWith("# ")) return <div key={j} className="text-sm font-bold mb-1" style={{ color: "var(--text-primary)" }}>{line.slice(2)}</div>;
            if (line.startsWith("## ")) return <div key={j} className="text-xs font-semibold mb-0.5" style={{ color: "var(--text-primary)" }}>{line.slice(3)}</div>;
            if (line.trim() === "") return <div key={j} className="h-1" />;
            return <div key={j}>{line}</div>;
          })}
        </div>
      </div>
      <div className="absolute bottom-1 left-2 text-xs" style={{ color: "var(--text-muted)" }}>
        {index + 1}
      </div>
      {canDelete && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="absolute top-1 right-1 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[var(--glass-hover)]"
          style={{ color: "var(--text-muted)" }}
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

function SlideEditor({
  slides, activeSlide, onChangeSlide, onUpdateContent,
}: {
  slides: string[];
  activeSlide: number;
  onChangeSlide: (i: number) => void;
  onUpdateContent: (i: number, content: string) => void;
}) {
  const slide = slides[activeSlide] || "";

  return (
    <div className="flex flex-col h-full">
      {/* Slide navigation */}
      <div
        className="flex items-center justify-center gap-4 py-2 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--glass-border)" }}
      >
        <button
          onClick={() => onChangeSlide(Math.max(0, activeSlide - 1))}
          disabled={activeSlide === 0}
          className="p-1 rounded disabled:opacity-30"
        >
          <ChevronLeft size={16} style={{ color: "var(--text-secondary)" }} />
        </button>
        <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
          Slide {activeSlide + 1} of {slides.length}
        </span>
        <button
          onClick={() => onChangeSlide(Math.min(slides.length - 1, activeSlide + 1))}
          disabled={activeSlide === slides.length - 1}
          className="p-1 rounded disabled:opacity-30"
        >
          <ChevronRight size={16} style={{ color: "var(--text-secondary)" }} />
        </button>
      </div>

      {/* Slide editor — 16:9 aspect ratio preview + textarea */}
      <div className="flex-1 flex flex-col items-center p-8 overflow-auto">
        <div
          className="w-full max-w-3xl aspect-video rounded-xl p-8 flex items-center justify-center"
          style={{ background: "var(--bg-elevated)", border: "1px solid var(--glass-border)" }}
        >
          <div className="w-full h-full">
            {slide.split("\n").map((line, i) => {
              if (line.startsWith("# ")) return <h1 key={i} className="text-3xl font-bold mb-4" style={{ color: "var(--text-primary)", fontFamily: "var(--font-sans)" }}>{line.slice(2)}</h1>;
              if (line.startsWith("## ")) return <h2 key={i} className="text-xl font-semibold mb-2" style={{ color: "var(--text-primary)", fontFamily: "var(--font-sans)" }}>{line.slice(3)}</h2>;
              if (line.startsWith("- ")) return <li key={i} className="text-lg ml-6 mb-1" style={{ color: "var(--text-secondary)" }}>{line.slice(2)}</li>;
              if (line.trim() === "") return <div key={i} className="h-4" />;
              return <p key={i} className="text-lg mb-2" style={{ color: "var(--text-secondary)" }}>{line}</p>;
            })}
          </div>
        </div>

        {/* Markdown editor below */}
        <div className="w-full max-w-3xl mt-4">
          <div className="text-xs mb-1" style={{ color: "var(--text-muted)" }}>Edit slide markdown:</div>
          <textarea
            value={slide}
            onChange={(e) => onUpdateContent(activeSlide, e.target.value)}
            className="w-full rounded-lg p-3 text-sm resize-none outline-none"
            style={{
              background: "var(--glass)",
              border: "1px solid var(--glass-border)",
              color: "var(--text-primary)",
              fontFamily: "var(--font-mono)",
              minHeight: 100,
            }}
            rows={6}
          />
        </div>
      </div>
    </div>
  );
}
