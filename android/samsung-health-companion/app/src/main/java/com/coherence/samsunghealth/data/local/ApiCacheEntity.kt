package com.coherence.samsunghealth.data.local

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query

@Entity(tableName = "api_cache")
data class ApiCacheEntity(
  @PrimaryKey val key: String,
  val data: String,
  val cachedAt: Long = System.currentTimeMillis(),
)

@Dao
interface ApiCacheDao {

  @Query("SELECT * FROM api_cache WHERE `key` = :key AND cachedAt > :minTime LIMIT 1")
  suspend fun get(key: String, minTime: Long): ApiCacheEntity?

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  suspend fun put(entity: ApiCacheEntity)

  @Query("DELETE FROM api_cache WHERE `key` = :key")
  suspend fun delete(key: String)

  @Query("DELETE FROM api_cache WHERE cachedAt < :before")
  suspend fun deleteOlderThan(before: Long)

  @Query("DELETE FROM api_cache")
  suspend fun clearAll()
}
