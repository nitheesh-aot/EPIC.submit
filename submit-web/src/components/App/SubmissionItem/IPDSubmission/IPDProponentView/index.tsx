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
import { useMemo, useState } from "react";
import Form from "@/components/Shared/Forms/common";
import { FormProvider, useForm } from "react-hook-form";
import { IPDSubmissionForm, ipdSubmissionSchema } from "./constants";
import { yupResolver } from "@hookform/resolvers/yup";
import { useQueryClient } from "@tanstack/react-query";
import { SubmissionItem } from "@/models/SubmissionItem";
import { QUERY_KEY } from "@/hooks/api/constants";
import {
  SUBMISSION_ITEM_STATUS,
  SUBMISSION_TYPE,
  SubmissionItemStatus,
} from "@/models/Submission";
import { S3_FOLDER } from "@/hooks/api/useObjectStorage";
import { useSaveSubmission } from "@/hooks/api/useSubmissions";
import { useGetSubmissionPackage } from "@/hooks/api/usePackages";
import { notify } from "@/components/Shared/Snackbar/snackbarStore";
import { isAxiosError } from "axios";
import SubmissionActionButtons from "@/components/App/SubmissionItem/SubmissionActionButtons";

export const IPDSubmissionProponentView = () => {
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

  const documentSubmissions = submissionItem?.submissions?.filter(
    (submission) => submission.type === SUBMISSION_TYPE.DOCUMENT,
  );

  const defaultDocumentValues = useMemo(() => {
    if (!documentSubmissions) return {};

    return {
      ipd: documentSubmissions
        .filter(
          (submission) =>
            submission.submitted_document?.folder === S3_FOLDER.IPDS.value,
        )
        .map((submission) => submission.submitted_document?.url),
      supportingIpd: documentSubmissions
        .filter(
          (submission) =>
            submission.submitted_document?.folder ===
            S3_FOLDER.IPD_SUPPORTING_DOCUMENTS.value,
        )
        .map((submission) => submission.submitted_document?.url),
    };
  }, [documentSubmissions]);

  const methods = useForm<IPDSubmissionForm>({
    resolver: yupResolver(ipdSubmissionSchema),
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

  const handleCompleteForm = (formData: IPDSubmissionForm) => {
    if (!formData.ipd?.length) {
      saveSubmission(formData, submissionItem?.status);
    } else {
      saveSubmission(formData, SUBMISSION_ITEM_STATUS.COMPLETED.value);
    }
  };

  const saveSubmission = async (
    _formData: IPDSubmissionForm,
    status?: SubmissionItemStatus,
  ) => {
    try {
      setIsBackdropOpen(true);
      await callSaveSubmission({
        data: {
          type: SUBMISSION_TYPE.FORM,
          status,
          item_id: submissionItemId,
          data: {}, // No form fields for IPD
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

  const documentUploadSections: UploadSectionConfig[] = useMemo(
    () => [
      {
        name: "ipd",
        label: "Initial Project Description",
        folder: S3_FOLDER.IPDS.value,
      },
      {
        name: "supportingIpd",
        label: "Supporting Documents",
        folder: S3_FOLDER.IPD_SUPPORTING_DOCUMENTS.value,
        description:
          "Must be unlocked PDF document (i.e., not password protected).",
      },
    ],
    [],
  );

  if (!accountProject) return <Navigate to="/error" />;
  return (
    <SubmissionFormContainer>
      <SubmitLoaderBackdrop isOpen={isBackdropOpen} />
      <FormProvider {...methods}>
        <Form methods={methods}>
          <Grid container spacing={BCDesignTokens.layoutMarginMedium}>
            <Grid item xs={12}>
              <GenericDocumentUploadSection sections={documentUploadSections} />
            </Grid>
            <SubmissionActionButtons
              onSubmit={handleSubmit(handleCompleteForm)}
              submitButtonText="Save & Exit"
            />
          </Grid>
        </Form>
      </FormProvider>
    </SubmissionFormContainer>
  );
};
