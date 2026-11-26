import type { AskUserQuestionItem } from '../../types/events.js';
import { AcpHandlerError } from './connection.js';
import { asRecord, type AcpRecord } from './protocol.js';

function invalidForm(): never {
  throw new AcpHandlerError(-32602, 'Unsupported ACP question form');
}

function choicesFor(field: AcpRecord) {
  if (Array.isArray(field.oneOf)) {
    return field.oneOf.map((item) => {
      const { const: value, title, description } = asRecord(item);
      if (typeof value !== 'string' || typeof title !== 'string' || !title.trim()) return invalidForm();
      return { value, label: title, ...(typeof description === 'string' ? { description } : {}) };
    });
  }
  if (Array.isArray(field.enum)) {
    return field.enum.map((value) => {
      if (typeof value !== 'string' || !value.trim()) return invalidForm();
      return { value, label: value, description: undefined };
    });
  }
  return undefined;
}

export function parseQuestionForm(params: AcpRecord) {
  const schema = asRecord(params.requestedSchema);
  const fields = Object.entries(asRecord(schema.properties));
  if (params.mode !== 'form' || schema.type !== 'object' || !fields.length) return invalidForm();

  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const properties = asRecord(schema.properties);
  const pairedOtherFields = new Set<string>();
  for (const [id, rawField] of fields) {
    const otherId = id + '_other';
    const other = asRecord(properties[otherId]);
    if (/^q\d+$/.test(id) && choicesFor(asRecord(rawField))?.length &&
        other.type === 'string' && other.title === 'Other' &&
        other.pattern === undefined && other.format === undefined &&
        other.minLength === undefined && other.maxLength === undefined &&
        !required.has(id) && !required.has(otherId)) {
      pairedOtherFields.add(otherId);
    }
  }
  const questions: AskUserQuestionItem[] = [];
  const readers: Array<(answers: Record<string, string>, content: Record<string, string>) => boolean> = [];
  for (const [id, rawField] of fields) {
    // Antigravity pairs each choice field with an optional free-form answer.
    if (pairedOtherFields.has(id)) continue;
    const field = asRecord(rawField);
    if (field.type !== 'string' || field.pattern !== undefined || field.format !== undefined) return invalidForm();
    const choices = choicesFor(field);
    const otherId = pairedOtherFields.has(id + '_other') ? id + '_other' : undefined;
    const labels = choices?.map((option) => option.label);
    if (labels && (!labels.length || new Set(labels).size !== labels.length)) return invalidForm();
    const title = typeof field.title === 'string' && field.title.trim() ? field.title : id;
    const message = typeof params.message === 'string' ? params.message : '';
    const description = typeof field.description === 'string' ? field.description : '';
    const question = [questions.length === 0 ? message : '', title, description].filter(Boolean).join('\n\n');
    const minLength = typeof field.minLength === 'number' ? field.minLength : undefined;
    const maxLength = typeof field.maxLength === 'number' ? field.maxLength : undefined;
    questions.push({
      id, question, options: choices?.map(({ label, description }) => ({ label, description })),
      answerConstraints: { required: required.has(id), choices: otherId ? undefined : labels, minLength, maxLength },
    });
    readers.push((answers, content) => {
      const answer = Object.hasOwn(answers, id) ? answers[id] : undefined;
      if (typeof answer !== 'string' || !answer.trim()) return !required.has(id);
      const choice = choices?.find((option) => option.label === answer);
      if (choice) content[id] = choice.value;
      else if (otherId) content[otherId] = answer;
      else if (choices) return false;
      else {
        const length = Array.from(answer).length;
        if ((minLength !== undefined && length < minLength) || (maxLength !== undefined && length > maxLength)) return false;
        content[id] = answer;
      }
      return true;
    });
  }
  return {
    questions,
    read(answers: Record<string, string>) {
      const content: Record<string, string> = Object.create(null);
      return readers.every((read) => read(answers, content)) ? content : undefined;
    },
  };
}
