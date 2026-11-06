// Editing engine process (MuPDF): the document of record, saving, batch jobs.
import { startHost, editHandlers } from './host';
import { withSink } from './mu';
startHost('edit', editHandlers(), withSink);
