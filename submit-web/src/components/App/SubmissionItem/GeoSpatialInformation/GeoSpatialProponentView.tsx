import { Navigate, useNavigate, useParams } from "@tanstack/react-router";
import { useGetAccountProject } from "@/hooks/api/useProjects";
import { SubmissionFormContainer } from "@/components/App/SubmissionItem/SubmissionFormContainer";
import { BCDesignTokens } from "epic.theme";
import { SubmitLoaderBackdrop } from "@/components/Shared/Overlays/SubmitLoaderBackdrop";
import { Grid } from "@mui/material";
import {
  GenericDocumentUploadSection,
  UploadSectionConfig,
} from "@/components/App/DocumentUpload/GenericDocumentUploadSection";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
} from "react";
import Form from "@/components/Shared/Forms/common";
import { FormProvider, useForm } from "react-hook-form";
import { Submission } from "@/models/Submission";
import {
  GeoSpatialSubmissionForm,
  geospatialSubmissionSchema,
} from "./constants";
import { GeoSpatialGuidelines } from "./GeoSpatialGuidelines";
import { yupResolver } from "@hookform/resolvers/yup";
import { useQueryClient } from "@tanstack/react-query";
import { SubmissionItem } from "@/models/SubmissionItem";
import { QUERY_KEY } from "@/hooks/api/constants";
import {
  SUBMISSION_ITEM_STATUS,
  SUBMISSION_TYPE,
  SubmissionItemStatus,
} from "@/models/Submission";
import { deleteDocument, S3_FOLDER } from "@/hooks/api/useObjectStorage";
import {
  useSaveSubmission,
  useDeleteSubmission,
} from "@/hooks/api/useSubmissions";
import { useGetSubmissionPackage } from "@/hooks/api/usePackages";
import { notify } from "@/components/Shared/Snackbar/snackbarStore";
import { isAxiosError } from "axios";
import SubmissionActionButtons from "@/components/App/SubmissionItem/SubmissionActionButtons";
import {
  useGetGeoUploads,
  useApproveGeoUpload,
  GeoUpload,
} from "@/hooks/api/useGeo";
import { useFileStore } from "@/store/fileStore";
// Lazy-load the map modal so maplibre-gl is not downloaded until first use
const MapPreviewModal = lazy(() =>
  import("@/components/App/Map/MapPreviewModal").then((m) => ({
    default: m.MapPreviewModal,
  })),
);

export const GeoSpatialProponentView = () => {
  const {
    projectId: accountProjectIdParam,
    submissionPackageId,
    submissionId: submissionItemId,
  } = useParams({
    from: "/proponent/_proponentLayout/projects/$projectId/_projectLayout/submission-packages/$submissionPackageId/_submissionLayout/submissions/$submissionId",
  });

  const accountProjectId = Number(accountProjectIdParam);
  const { data: accountProject } = useGetAccountProject({
    accountProjectId,
  });

  const queryClient = useQueryClient();
  const submissionItem = queryClient.getQueryData<SubmissionItem>([
    QUERY_KEY.SUBMISSION_ITEM,
    Number(submissionItemId),
  ]);

  const navigate = useNavigate();

  const [isBackdropOpen, setIsBackdropOpen] = useState(false);
  const [previewDocument, setPreviewDocument] = useState<Submission | null>(
    null,
  );
  const [reviewQueue, setReviewQueue] = useState<Submission[]>([]);

  const { data: geoUploads } = useGetGeoUploads({
    itemId: Number(submissionItemId),
    autoRefetch: true,
  });
  const uploads = geoUploads as unknown as GeoUpload[];

  // Derive previewUpload reactively so it updates as polling resolves the status
  const previewUpload = useMemo<GeoUpload | null>(() => {
    if (!previewDocument || !uploads) return null;
    return (
      uploads.find(
        (u) => u.raw_s3_key === previewDocument.submitted_document?.url,
      ) ?? null
    );
  }, [previewDocument, uploads]);

  const { mutateAsync: deleteSubmissionAsync } = useDeleteSubmission({
    submissionItemId: Number(submissionItemId),
  });
  const { mutateAsync: approveGeoUpload } = useApproveGeoUpload();
  const { removeFile } = useFileStore();

  const documentSubmissions = submissionItem?.submissions?.filter(
    (submission) => submission.type === SUBMISSION_TYPE.DOCUMENT,
  );

  const defaultDocumentValues = useMemo(() => {
    if (!documentSubmissions) return {};

    return {
      geospatial: documentSubmissions
        .filter(
          (submission) =>
            submission.submitted_document?.folder ===
            S3_FOLDER.GEOSPATIAL.value,
        )
        .map((submission) => submission.submitted_document?.url),
    };
  }, [documentSubmissions]);

  const methods = useForm<GeoSpatialSubmissionForm>({
    resolver: yupResolver(geospatialSubmissionSchema),
    mode: "onSubmit",
    defaultValues: {
      ...defaultDocumentValues,
    },
  });

  const { handleSubmit } = methods;

  const { refetch } = useGetSubmissionPackage({
    packageId: Number(submissionPackageId),
  });

  const { mutateAsync: callSaveSubmission } = useSaveSubmission({
    accountProjectId,
    submissionItem,
  });

  const handleCompleteForm = (formData: GeoSpatialSubmissionForm) => {
    if (!formData.geospatial?.length) {
      saveSubmission(formData, submissionItem?.status);
    } else {
      saveSubmission(formData, SUBMISSION_ITEM_STATUS.COMPLETED.value);
    }
  };

  const saveSubmission = async (
    _formData: GeoSpatialSubmissionForm,
    status?: SubmissionItemStatus,
  ) => {
    try {
      setIsBackdropOpen(true);
      await callSaveSubmission({
        data: {
          type: SUBMISSION_TYPE.FORM,
          status,
          item_id: submissionItemId,
          data: {},
        },
      });

      await refetch();
      notify.success("Submission saved successfully");
      navigate({
        to: `/proponent/projects/${accountProjectId}/submission-packages/${submissionPackageId}`,
      });
    } catch (error) {
      const errorMessage =
        isAxiosError(error) && error.response?.data?.message
          ? error.response.data.message
          : "Failed to save submission";
      notify.error(errorMessage);
    } finally {
      setIsBackdropOpen(false);
    }
  };

  // Advances to the next file in the review queue
  const openNextInQueue = useCallback((queue: Submission[]) => {
    const [next, ...remaining] = queue;
    setReviewQueue(remaining);
    setPreviewDocument(next ?? null);
  }, []);

  // Called by PendingDocumentRow once a geo file finishes uploading
  const onUploadComplete = useCallback(
    (submission: Submission) => {
      if (previewDocument !== null) {
        setReviewQueue((prev) => [...prev, submission]);
      } else {
        setPreviewDocument(submission);
      }
    },
    [previewDocument],
  );

  const handleApprove = useCallback(async () => {
    // Persist approval server-side so navigating away (back/refresh) cannot
    // bypass the review step — the item can't be completed until every upload
    // is approved.
    if (previewUpload) {
      try {
        await approveGeoUpload(previewUpload.id);
      } catch {
        notify.error("Failed to approve geospatial file");
        return;
      }
    }
    openNextInQueue(reviewQueue);
  }, [previewUpload, reviewQueue, openNextInQueue, approveGeoUpload]);

  const handleReject = useCallback(async () => {
    if (!previewDocument) return;
    const filepath = previewDocument.submitted_document?.url ?? "";

    // Remove from form immediately for snappy UX
    const current = methods.getValues("geospatial") as string[];
    methods.setValue(
      "geospatial",
      current.filter((v) => v !== filepath),
      { shouldValidate: true },
    );

    try {
      await deleteDocument({ filepath });
    } catch {
      // Non-blocking — S3 delete failure doesn't prevent DB record removal
    }

    try {
      await deleteSubmissionAsync(previewDocument.id);
    } catch {
      notify.error("Failed to remove geospatial file");
    }

    removeFile(previewDocument.id);
    openNextInQueue(reviewQueue);
  }, [
    previewDocument,
    reviewQueue,
    methods,
    deleteSubmissionAsync,
    removeFile,
    openNextInQueue,
  ]);

  // On return to the page (e.g. after a back/refresh during processing), re-open
  // the review modal for any upload the proponent never approved. Runs once per
  // mount; new uploads within the session are handled by onUploadComplete.
  const didSeedReview = useRef(false);
  useEffect(() => {
    if (didSeedReview.current) return;
    if (!uploads || !documentSubmissions) return;

    const unapproved = uploads.filter((u) => !u.is_approved);
    if (unapproved.length === 0) {
      didSeedReview.current = true;
      return;
    }

    const docs = unapproved
      .map((upload) =>
        documentSubmissions.find(
          (s) => s.submitted_document?.url === upload.raw_s3_key,
        ),
      )
      .filter((d): d is Submission => Boolean(d));

    // Wait until the matching document submissions are available in cache.
    if (docs.length < unapproved.length) return;

    didSeedReview.current = true;
    const [first, ...rest] = docs;
    setPreviewDocument(first);
    setReviewQueue(rest);
  }, [uploads, documentSubmissions]);

  // Save & Exit is blocked while a review is open/queued, or any upload for this
  // item is still unapproved (the server enforces the same rule on submit).
  const hasUnapprovedUploads = useMemo(
    () => (uploads ?? []).some((u) => !u.is_approved),
    [uploads],
  );
  const isReviewPending =
    previewDocument !== null || reviewQueue.length > 0 || hasUnapprovedUploads;

  const documentUploadSections: UploadSectionConfig[] = useMemo(
    () => [
      {
        name: "geospatial",
        label: "Geospatial Files",
        folder: S3_FOLDER.GEOSPATIAL.value,
        acceptedFileTypes: ["shp", "zip"],
        acceptedFileTypesCriteria: "Must contain shape files",
        onUploadComplete,
        onDocumentClick: (documentItem) => {
          const url = documentItem.submitted_document?.url;
          if (!url) return;
          const upload = uploads?.find((u) => u.raw_s3_key === url);

          if (!upload) {
            notify.error("Preview is not available for this file.");
            return;
          }

          if (upload.status === "processing") {
            notify.info("Geospatial processing is in progress. Please wait.");
            return;
          }

          setPreviewDocument(documentItem);
        },
      },
    ],
    [uploads, onUploadComplete],
  );

  if (!accountProject) return <Navigate to="/error" />;
  return (
    <SubmissionFormContainer>
      <SubmitLoaderBackdrop isOpen={isBackdropOpen} />
      <FormProvider {...methods}>
        <Form methods={methods}>
          <Grid container spacing={BCDesignTokens.layoutMarginMedium}>
            <Grid item xs={12}>
              <GeoSpatialGuidelines />
            </Grid>
            <Grid item xs={12}>
              <GenericDocumentUploadSection
                sections={documentUploadSections}
                title="Geospatial File(s) Upload"
              />
            </Grid>

            {/* Map Preview Modal — lazy loaded, only downloads maplibre-gl on first open */}
            <Suspense fallback={null}>
              <MapPreviewModal
                open={previewDocument !== null}
                uploadId={previewUpload?.id ?? null}
                documentItem={previewDocument}
                fileSizeKb={previewUpload?.file_size_kb}
                status={
                  previewUpload?.status ??
                  (previewDocument !== null ? "processing" : undefined)
                }
                errorMessage={previewUpload?.error_message}
                validationErrors={previewUpload?.validation_errors}
                isApproved={previewUpload?.is_approved}
                onApprove={handleApprove}
                onReject={handleReject}
                onClose={() => openNextInQueue(reviewQueue)}
              />
            </Suspense>

            <SubmissionActionButtons
              onSubmit={handleSubmit(handleCompleteForm)}
              submitButtonText="Save & Exit"
              submitCondition={isReviewPending}
            />
          </Grid>
        </Form>
      </FormProvider>
    </SubmissionFormContainer>
  );
};
