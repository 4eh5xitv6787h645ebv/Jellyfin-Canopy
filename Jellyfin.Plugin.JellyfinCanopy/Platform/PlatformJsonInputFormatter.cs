using System;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Formatters;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>Uses the Platform wire serializer for Platform body parameters only.</summary>
    public sealed class PlatformJsonInputFormatter : IInputFormatter
    {
        /// <inheritdoc />
        public bool CanRead(InputFormatterContext context)
        {
            ArgumentNullException.ThrowIfNull(context);

            var descriptor = context.HttpContext.GetEndpoint()?.Metadata.GetMetadata<ControllerActionDescriptor>();
            return descriptor?.ControllerTypeInfo is TypeInfo controller
                && typeof(PlatformControllerBase).IsAssignableFrom(controller.AsType())
                && PlatformJsonMediaTypeFilter.IsJson(context.HttpContext.Request.ContentType);
        }

        /// <inheritdoc />
        public async Task<InputFormatterResult> ReadAsync(InputFormatterContext context)
        {
            ArgumentNullException.ThrowIfNull(context);

            try
            {
                var value = await JsonSerializer.DeserializeAsync(
                    context.HttpContext.Request.Body,
                    context.ModelType,
                    PlatformJson.SerializerOptions,
                    context.HttpContext.RequestAborted).ConfigureAwait(false);

                return await InputFormatterResult.SuccessAsync(value).ConfigureAwait(false);
            }
            catch (JsonException exception)
            {
                context.ModelState.TryAddModelError(
                    PlatformRequestFilter.NormalizeField(exception.Path),
                    "The JSON value is invalid.");
                return await InputFormatterResult.FailureAsync().ConfigureAwait(false);
            }
        }
    }
}
