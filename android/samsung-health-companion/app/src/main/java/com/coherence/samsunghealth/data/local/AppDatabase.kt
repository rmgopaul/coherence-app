package com.coherence.samsunghealth.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
  entities = [ApiCacheEntity::class],
  version = 1,
  exportSchema = false,
)
abstract class AppDatabase : RoomDatabase() {
  abstract fun apiCacheDao(): ApiCacheDao

  companion object {
    @Volatile
    private var INSTANCE: AppDatabase? = null

    fun getInstance(context: Context): AppDatabase {
      return INSTANCE ?: synchronized(this) {
        INSTANCE ?: Room.databaseBuilder(
          context.applicationContext,
          AppDatabase::class.java,
          "coherence_dashboard.db",
        )
          .fallbackToDestructiveMigration(true)
          .build()
          .also { INSTANCE = it }
      }
    }
  }
}
