package com.coherence.healthconnect.ui.state

sealed class LoadState<out T> {
  data object Loading : LoadState<Nothing>()

  data class Content<T>(
    val data: T,
    val updatedAtMillis: Long = System.currentTimeMillis(),
  ) : LoadState<T>()

  data class Error<T>(
    val message: String,
    val previousData: T? = null,
    val updatedAtMillis: Long? = null,
  ) : LoadState<T>()
}

fun <T> LoadState<T>.isLoading(): Boolean = this is LoadState.Loading

fun <T> LoadState<T>.dataOrNull(): T? = when (this) {
  is LoadState.Content -> data
  is LoadState.Error -> previousData
  LoadState.Loading -> null
}

fun <T> LoadState<T>.errorOrNull(): String? = when (this) {
  is LoadState.Error -> message
  else -> null
}

fun <T> LoadState<T>.updatedAtOrNull(): Long? = when (this) {
  is LoadState.Content -> updatedAtMillis
  is LoadState.Error -> updatedAtMillis
  LoadState.Loading -> null
}
