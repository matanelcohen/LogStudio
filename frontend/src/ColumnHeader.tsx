import * as Menu from "@radix-ui/react-dropdown-menu";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { flexRender, type Header } from "@tanstack/react-table";
import { ArrowLeft, ArrowRight, ChevronDown, EyeOff, GripVertical, RotateCcw } from "lucide-react";
import type { LogEntry } from "./model";

const KeyboardResizeStep = 16;

export function ColumnHeader({ header, order, onMove, onResize }: {
  header: Header<LogEntry, unknown>;
  order: string[];
  onMove(id: string, direction: number): void;
  onResize(id: string, width: number): void;
}) {
  const column = header.column;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: column.id });

  return <th ref={setNodeRef} scope="col" data-column-id={column.id}
    style={{ transform: CSS.Translate.toString(transform), transition, zIndex: isDragging ? 3 : 1 }}
    className={isDragging ? "dragging-column" : undefined}>
    <div className="table-column-heading">
      <button ref={setActivatorNodeRef} className="column-drag-handle icon-button"
        {...attributes} {...listeners} aria-label={`Drag ${column.id} column`} title="Drag to reorder; Space then arrow keys also work">
        <GripVertical size={12} />
      </button>
      <span>{flexRender(column.columnDef.header, header.getContext())}</span>
      <Menu.Root>
        <Menu.Trigger asChild><button className="column-menu icon-button" aria-label={`${column.id} column options`}><ChevronDown size={11} /></button></Menu.Trigger>
        <Menu.Portal><Menu.Content className="menu-content" sideOffset={4}>
          <Menu.Item className="menu-item" disabled={!column.getCanHide()} onSelect={() => column.toggleVisibility(false)}><EyeOff size={13} /> Hide column</Menu.Item>
          <Menu.Item className="menu-item" disabled={order.indexOf(column.id) <= 0} onSelect={() => onMove(column.id, -1)}><ArrowLeft size={13} /> Move left</Menu.Item>
          <Menu.Item className="menu-item" disabled={order.indexOf(column.id) >= order.length - 1} onSelect={() => onMove(column.id, 1)}><ArrowRight size={13} /> Move right</Menu.Item>
          <Menu.Item className="menu-item" onSelect={() => column.resetSize()}><RotateCcw size={13} /> Reset width</Menu.Item>
        </Menu.Content></Menu.Portal>
      </Menu.Root>
    </div>
    <div className={`column-resizer ${column.getIsResizing() ? "resizing" : ""}`} role="separator" aria-orientation="vertical"
      aria-label={`Resize ${column.id} column`} aria-valuenow={header.getSize()} tabIndex={0}
      onMouseDown={header.getResizeHandler()} onTouchStart={header.getResizeHandler()}
      onDoubleClick={() => column.resetSize()}
      onKeyDown={event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const width = Math.max(column.columnDef.minSize ?? 40, header.getSize() + (event.key === "ArrowRight" ? KeyboardResizeStep : -KeyboardResizeStep));
        onResize(column.id, width);
      }}><GripVertical size={11} /></div>
  </th>;
}
