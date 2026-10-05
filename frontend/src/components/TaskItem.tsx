import type { Task } from '../types';
import { CheckIcon, ClockIcon, PencilIcon, TrashIcon } from './Icons';
import { fmtShort, isOverdue } from '../utils/dates';
interface P { task: Task; showDate?: boolean; selected: boolean; onToggle(t: Task): void; onEdit(t: Task): void; onDelete(t: Task): void; onSelect(): void }
export default function TaskItem({ task, showDate, selected, onToggle, onEdit, onDelete, onSelect }: P) {
  const late = isOverdue(task.due_date, task.completed);
  return (
    <li className={`task${task.completed ? ' done' : ''}${late ? ' late' : ''}${selected ? ' sel' : ''}`} data-task-id={task.id} tabIndex={0} onFocus={onSelect}>
      <button type="button" role="checkbox" aria-checked={task.completed} aria-label={`Concluir: ${task.title}`} className="check" onClick={() => onToggle(task)}>
        <CheckIcon />
      </button>
      <span className="title" title={task.title}>{task.title}</span>
      {late && <span className="badge" tabIndex={0} aria-label="Em atraso"><ClockIcon /><span>Em atraso</span></span>}
      {showDate && task.due_date && <span className="date">{fmtShort(task.due_date)}</span>}
      <span className="actions">
        <button type="button" className="icon sm" aria-label={`Editar: ${task.title}`} onClick={() => onEdit(task)}><PencilIcon /></button>
        <button type="button" className="icon sm" aria-label={`Excluir: ${task.title}`} onClick={() => onDelete(task)}><TrashIcon /></button>
      </span>
    </li>
  );
}
