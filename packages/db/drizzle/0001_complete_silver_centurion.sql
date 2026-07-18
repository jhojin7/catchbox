CREATE TABLE `capture_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`client_batch_id` text NOT NULL,
	`source_platform` text,
	`source_app` text,
	`captured_at` text NOT NULL,
	`received_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `capture_batches_user_client_id_unique` ON `capture_batches` (`user_id`,`client_batch_id`);--> statement-breakpoint
CREATE INDEX `capture_batches_user_received_index` ON `capture_batches` (`user_id`,`received_at`,`id`);--> statement-breakpoint
CREATE TABLE `capture_items` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`user_id` text NOT NULL,
	`client_item_id` text NOT NULL,
	`type` text NOT NULL,
	`text_content` text NOT NULL,
	`processing_state` text NOT NULL,
	`inbox_state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `capture_batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "capture_items_type_check" CHECK("capture_items"."type" = 'text'),
	CONSTRAINT "capture_items_processing_state_check" CHECK("capture_items"."processing_state" = 'ready'),
	CONSTRAINT "capture_items_inbox_state_check" CHECK("capture_items"."inbox_state" = 'inbox')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `capture_items_user_client_id_unique` ON `capture_items` (`user_id`,`client_item_id`);--> statement-breakpoint
CREATE INDEX `capture_items_batch_id_index` ON `capture_items` (`batch_id`);