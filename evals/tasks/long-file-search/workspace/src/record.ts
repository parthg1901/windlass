export interface Rec {
  id: string
  name: string
  archived: boolean
  locked: boolean
  flagged: boolean
  open: boolean
  deleted: boolean
  version: number
  tags: string[]
  history: string[]
  updatedBy: string | null
}

export function sample(id: string): Rec {
  return { id, name: ` ${id} `, archived: false, locked: false, flagged: false, open: true, deleted: false, version: 1, tags: [], history: [], updatedBy: null }
}
