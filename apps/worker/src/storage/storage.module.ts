import { Inject, Module } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { WORKER_CONFIG } from '../config/config.module';
import type { WorkerConfig } from '../config/config.module';
import { OBJECT_STORAGE } from './object-storage';
import type { ObjectStorage } from './object-storage';
import { S3ObjectStorage } from './s3-object-storage';

/** The private object store (S3), shared by what writes files (PDFs) and what reads them (email attachments). */
@Module({
  providers: [
    {
      provide: OBJECT_STORAGE,
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig) => new S3ObjectStorage(config),
    },
  ],
  exports: [OBJECT_STORAGE],
})
export class StorageModule implements OnApplicationShutdown {
  constructor(@Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage) {}

  onApplicationShutdown(): void {
    (this.storage as { close?: () => void }).close?.();
  }
}
