/**
 * Project types for StudyFucker
 */

/**
 * Project status
 */
export type ProjectStatus = 
  | 'initializing'    // WebContainer is being set up
  | 'template-uploading' // LaTeX template is being created
  | 'generating'      // AI is generating thesis content
  | 'compiling'       // LaTeX is being compiled to PDF
  | 'applying-changes' // Changes are being applied
  | 'error'           // Error occurred
  | 'ready';          // Thesis is ready

/**
 * Project information
 */
export interface Project {
  id: string;
  title: string;
  description: string;
  status: ProjectStatus;
  createdAt: Date;
  updatedAt: Date;
  
  // Thesis information
  topic?: string;
  researchQuestion?: string;
  methodology?: string;
  field?: string; // e.g., 'Computer Science', 'Biology', etc.
  
  // Thesis content
  latexContent?: string;
  pdfUrl?: string;
  
  // WebContainer
  webcontainerId?: string;
  
  // Supabase
  supabaseProjectId?: string;
  filesStored?: boolean;
  vectorStoreReady?: boolean;
}

/**
 * New project creation data
 */
export interface NewProjectData {
  title: string;
  description: string;
  userPrompt: string;
  topic?: string;
  field?: string;
}

