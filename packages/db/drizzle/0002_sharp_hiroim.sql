PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`client_kind` text NOT NULL,
	`session_version` integer NOT NULL,
	`idle_expires_at` text NOT NULL,
	`absolute_expires_at` text NOT NULL,
	`last_used_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sessions_client_kind_check" CHECK("client_kind" in ('browser', 'script', 'android', 'ios'))
);
--> statement-breakpoint
INSERT INTO `__new_sessions`("id", "token_hash", "user_id", "client_kind", "session_version", "idle_expires_at", "absolute_expires_at", "last_used_at", "revoked_at", "created_at") SELECT "id", "token_hash", "user_id", "client_kind", "session_version", "idle_expires_at", "absolute_expires_at", "last_used_at", "revoked_at", "created_at" FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_id_index` ON `sessions` (`user_id`);
